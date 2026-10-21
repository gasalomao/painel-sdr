import { describe, expect, it } from "vitest";
import { canonicalCrmIdentity, resolveContactLead } from "./contact-crm";

const row = (id: number, client_id = "tenant-a", telefone: string | null = "(11) 8765-4321", remoteJid: string | null = null) => ({ id, client_id, telefone, remoteJid, status: "interessado", nome_negocio: "Vidraçaria Geral", created_at: "2026-01-01" });

function database(rows: ReturnType<typeof row>[], fail = false) {
  const queries: { filters: [string, unknown][]; range?: [number, number] }[] = [];
  return {
    queries,
    from: () => {
      const query = { filters: [] as [string, unknown][], range: undefined as [number, number] | undefined };
      queries.push(query);
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => { query.filters.push([key, value]); return builder; },
        order: () => builder,
        range: (from: number, to: number) => { query.range = [from, to]; return builder; },
        maybeSingle: () => builder,
        then: (resolve: (value: unknown) => unknown) => {
          const data = rows.filter((r) => query.filters.every(([k, v]) => String(r[k as keyof typeof r]) === String(v)));
          const result = query.range ? data.slice(query.range[0], query.range[1] + 1) : data[0] ?? null;
          return Promise.resolve(resolve({ data: result, error: fail ? { message: "DB offline" } : null }));
        },
      };
      return builder;
    },
  };
}
const db = (fake: ReturnType<typeof database>) => fake as unknown as Parameters<typeof resolveContactLead>[0];

describe("CRM identity", () => {
  it.each(["+55 (11) 98765-4321", "(11) 8765-4321", "phone:551187654321", "0055 11 98765-4321", "0 (11) 98765-4321", "5511987654321:2@s.whatsapp.net", "551187654321@c.us"])("canonicaliza %s sem alterar utilitários compartilhados", (value) => {
    expect(canonicalCrmIdentity(value)).toBe("551187654321@s.whatsapp.net");
  });
  it("não confunde DDD, país, fixos, grupos ou LIDs", () => {
    expect(canonicalCrmIdentity("+55 21 98765-4321")).not.toBe(canonicalCrmIdentity("+55 11 98765-4321"));
    expect(canonicalCrmIdentity("(11) 93456-7890")).not.toBe(canonicalCrmIdentity("(11) 3456-7890"));
    expect(canonicalCrmIdentity("5511987654321@lid")).toBe("5511987654321@lid");
    expect(canonicalCrmIdentity("123456@g.us")).toBe("123456@g.us");
    expect(canonicalCrmIdentity("Vidraçaria Geral")).toBeNull();
    expect(canonicalCrmIdentity("+1 (234) 567-8901")).not.toBe(canonicalCrmIdentity("(12) 34567-8901"));
    expect(canonicalCrmIdentity("12345678901@s.whatsapp.net")).not.toBe(canonicalCrmIdentity("(12) 34567-8901"));
    expect(canonicalCrmIdentity("5511987654321@lid")).not.toBe(canonicalCrmIdentity("5511987654321@s.whatsapp.net"));
  });
});

describe("resolveContactLead", () => {
  it("encontra telefone formatado BR sem depender de nome e ignora outro tenant", async () => {
    const fake = database([row(1, "tenant-b"), { ...row(2), nome_negocio: "Nome diferente" }]);
    const result = await resolveContactLead(db(fake), "tenant-a", { phone: "5511987654321" });
    expect(result).toMatchObject({ state: "found", lead: { id: 2 } });
    expect(fake.queries.every((q) => q.filters.some(([k, v]) => k === "client_id" && v === "tenant-a"))).toBe(true);
  });
  it("prioriza lead_id válido do tenant e recupera vínculo órfão/estrangeiro por fallback", async () => {
    const fake = database([row(1, "tenant-b"), row(2), row(3, "tenant-a", "21999991111")]);
    expect(await resolveContactLead(db(fake), "tenant-a", { lead_id: 3, phone: "5511987654321" })).toMatchObject({ lead: { id: 3 } });
    for (const lead_id of [1, 999]) {
      expect(await resolveContactLead(db(fake), "tenant-a", { lead_id, phone: "5511987654321" })).toMatchObject({ lead: { id: 2 } });
    }
  });
  it("resolve remoteJid e remote_jid e não usa dígitos de LID como telefone", async () => {
    const fake = database([row(4, "tenant-a", null, "5511987654321@c.us")]);
    expect(await resolveContactLead(db(fake), "tenant-a", { remote_jid: "551187654321@s.whatsapp.net" })).toMatchObject({ lead: { id: 4 } });
    expect(await resolveContactLead(db(fake), "tenant-a", { remoteJid: "551187654321@s.whatsapp.net" })).toMatchObject({ lead: { id: 4 } });
    expect(await resolveContactLead(db(fake), "tenant-a", { remote_jid: "5511987654321@lid" })).toMatchObject({ state: "missing" });
  });
  it("não escolhe arbitrariamente entre correspondências canônicas ou identidades conflitantes", async () => {
    const fake = database([row(1), row(2, "tenant-a", "5511987654321")]);
    expect(await resolveContactLead(db(fake), "tenant-a", { phone: "11987654321" })).toMatchObject({ state: "ambiguous", lead: null });
    expect(await resolveContactLead(db(database([row(1)])), "tenant-a", { name: "Vidraçaria Geral" })).toMatchObject({ state: "unresolved" });
  });
  it("não reinterpreta como BR o telefone derivado de JID estrangeiro", async () => {
    const fake = database([row(4, "tenant-a", "(12) 34567-8901")]);
    expect(await resolveContactLead(db(fake), "tenant-a", { remote_jid: "12345678901@s.whatsapp.net", phone_number: "12345678901" })).toMatchObject({ state: "missing" });
  });
  it("não usa phone_number derivado de LID como telefone", async () => {
    const fake = database([row(4, "tenant-a", "5511987654321")]);
    expect(await resolveContactLead(db(fake), "tenant-a", { remote_jid: "5511987654321@lid", phone_number: "5511987654321" })).toMatchObject({ state: "missing" });
  });
  it("propaga falha em vez de afirmar inexistência", async () => {
    await expect(resolveContactLead(db(database([], true)), "tenant-a", { phone: "11987654321" })).rejects.toBeDefined();
  });
  it("pagina para não perder lead após o limite de retorno do Supabase", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row(i + 1, "tenant-a", null));
    rows[500].telefone = "(11) 8765-4321";
    const fake = database(rows);
    expect(await resolveContactLead(db(fake), "tenant-a", { phone: "11987654321" })).toMatchObject({ lead: { id: 501 } });
    expect(fake.queries).toHaveLength(2);
  });
});
