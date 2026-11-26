import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

describe("migration 030 — proxy_pool SQL, exclusividade 1:1 e concorrência real (PGlite)", () => {
  let db: PGlite;
  const sql030 = readFileSync(resolve("migrations/030_proxy_pool.sql"), "utf8");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(sql030);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("impede endpoint duplicado ativo, mas permite reinserção após status retired", async () => {
    await db.query(
      `INSERT INTO public.proxy_pool (host, port, protocol, username, password, status)
       VALUES ('198.51.100.10', 5992, 'http', 'u1', 'p1', 'available')`,
    );

    await expect(
      db.query(
        `INSERT INTO public.proxy_pool (host, port, protocol, username, password, status)
         VALUES ('198.51.100.10', 5992, 'http', 'u2', 'p2', 'available')`,
      ),
    ).rejects.toThrow();

    await db.query(`UPDATE public.proxy_pool SET status = 'retired' WHERE host = '198.51.100.10'`);

    await expect(
      db.query(
        `INSERT INTO public.proxy_pool (host, port, protocol, username, password, status)
         VALUES ('198.51.100.10', 5992, 'http', 'u2', 'p2', 'available')`,
      ),
    ).resolves.toBeDefined();

    await db.query(`DELETE FROM public.proxy_pool`);
  });

  it("garante 0 colisões com 50 instâncias simultâneas disputando 35 proxies e respeita reserva de aquecimento", async () => {
    const clientA = randomUUID();

    // Insere 35 proxies disponíveis
    for (let i = 1; i <= 35; i++) {
      await db.query(
        `INSERT INTO public.proxy_pool (host, port, protocol, username, password, status)
         VALUES ($1, $2, 'http', 'webshare_u', 'webshare_p', 'available')`,
        [`198.51.100.${10 + i}`, 6000 + i],
      );
    }

    // Reserva 5 proxies exclusivos para o Aquecedor -> conexões comuns podem usar no máximo 30
    const commonClaims = await Promise.all(
      Array.from({ length: 40 }, (_, idx) =>
        db.query<{ id: string; host: string; assigned_instance: string }>(
          `SELECT id, host, assigned_instance FROM public.claim_next_proxy($1, $2::uuid, 5, false)`,
          [`inst-common-${idx + 1}`, clientA],
        ),
      ),
    );

    const claimedCommon = commonClaims.flatMap((r) => r.rows);
    expect(claimedCommon).toHaveLength(30);
    // Zero colisão de IP ou instância
    expect(new Set(claimedCommon.map((r) => r.host)).size).toBe(30);
    expect(new Set(claimedCommon.map((r) => r.assigned_instance)).size).toBe(30);

    // 10 instâncias de Aquecedor entram na sequência -> consomem os 5 reservados restantes e 5 ficam sem proxy (fallback VPS)
    const warmupClaims = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        db.query<{ id: string; host: string; assigned_instance: string }>(
          `SELECT id, host, assigned_instance FROM public.claim_next_proxy($1, $2::uuid, 5, true)`,
          [`inst-warmup-${idx + 1}`, clientA],
        ),
      ),
    );
    const claimedWarmup = warmupClaims.flatMap((r) => r.rows);
    expect(claimedWarmup).toHaveLength(5);

    const allHosts = [...claimedCommon, ...claimedWarmup].map((r) => r.host);
    expect(new Set(allHosts).size).toBe(35);

    // Chamada concorrente duplicada para a MESMA instância retorna exatamente o mesmo proxy (idempotente)
    const [dup1, dup2] = await Promise.all([
      db.query<{ id: string; host: string }>(
        `SELECT id, host FROM public.claim_next_proxy('inst-warmup-1', $1::uuid, 5, true)`,
        [clientA],
      ),
      db.query<{ id: string; host: string }>(
        `SELECT id, host FROM public.claim_next_proxy('inst-warmup-1', $1::uuid, 5, true)`,
        [clientA],
      ),
    ]);
    expect(dup1.rows[0]?.id).toBe(dup2.rows[0]?.id);
  });

  it("blacklist_instance_proxy impede reutilização por outras instâncias e contabiliza fail_count", async () => {
    const clientB = randomUUID();
    await db.query(`DELETE FROM public.proxy_pool`);

    await db.query(
      `INSERT INTO public.proxy_pool (host, port, protocol, status)
       VALUES ('203.0.113.1', 5001, 'http', 'available'), ('203.0.113.2', 5002, 'http', 'available')`,
    );

    const claimA = await db.query<{ host: string }>(
      `SELECT host FROM public.claim_next_proxy('chip-alpha', $1::uuid, 0, true)`,
      [clientB],
    );
    const hostA = claimA.rows[0]?.host;
    expect(["203.0.113.1", "203.0.113.2"]).toContain(hostA);

    // Outro chip NUNCA pega o proxy em uso pelo chip-alpha
    const claimB = await db.query<{ host: string }>(
      `SELECT host FROM public.claim_next_proxy('chip-beta', $1::uuid, 0, true)`,
      [clientB],
    );
    const hostB = claimB.rows[0]?.host;
    expect(["203.0.113.1", "203.0.113.2"]).toContain(hostB);
    expect(hostB).not.toBe(hostA);

    // chip-alpha é excluído -> proxy vai para Lista Negra ('used') e NÃO volta como available
    const blUsed = await db.query<{ status: string; blacklist_reason: string; fail_count: number }>(
      `SELECT status, blacklist_reason, fail_count FROM public.blacklist_instance_proxy('chip-alpha', 'used', 'Excluído')`,
    );
    expect(blUsed.rows[0]?.status).toBe("blacklisted");
    expect(blUsed.rows[0]?.blacklist_reason).toBe("used");
    expect(blUsed.rows[0]?.fail_count).toBe(0);

    // chip-beta falha -> vai para Lista Negra ('failed') incrementando fail_count
    const blFailed = await db.query<{ status: string; blacklist_reason: string; fail_count: number }>(
      `SELECT status, blacklist_reason, fail_count FROM public.blacklist_instance_proxy('chip-beta', 'failed', 'Timeout 407')`,
    );
    expect(blFailed.rows[0]?.status).toBe("blacklisted");
    expect(blFailed.rows[0]?.blacklist_reason).toBe("failed");
    expect(blFailed.rows[0]?.fail_count).toBe(1);

    // chip-gamma entra agora -> pool vazio (nenhum proxy blacklisted é reutilizado!)
    const claimC = await db.query<{ host: string }>(
      `SELECT host FROM public.claim_next_proxy('chip-gamma', $1::uuid, 0, true)`,
      [clientB],
    );
    expect(claimC.rows).toHaveLength(0);
  });
});
