// @vitest-environment node
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  app_settings: [] as Array<{ key: string; value: string; updated_at?: string }>,
}));

const mocks = vi.hoisted(() => ({
  markMessageAsRead: vi.fn(async () => ({ ok: true })),
  sendReaction: vi.fn(async () => ({ key: { id: "react-1" } })),
  logAction: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let op: "select" | "upsert" = "select";
      let payload: { key: string; value: string; updated_at?: string } | null = null;
      let eqKey = "";
      type ChainType = {
        select: () => ChainType;
        eq: (_col: string, val: string) => ChainType;
        upsert: (p: { key: string; value: string; updated_at?: string }) => ChainType;
        maybeSingle: () => Promise<{ data: { key: string; value: string; updated_at?: string } | null; error: null }>;
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise<unknown>;
      };
      const chain: ChainType = {
        select: () => chain,
        eq: (_col: string, val: string) => {
          eqKey = val;
          return chain;
        },
        upsert: (p: { key: string; value: string; updated_at?: string }) => {
          op = "upsert";
          payload = p;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "app_settings") {
            const row = db.app_settings.find((r) => r.key === eqKey) || null;
            return { data: row ? { ...row } : null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          if (op === "upsert" && table === "app_settings" && payload) {
            const idx = db.app_settings.findIndex((r) => r.key === payload!.key);
            if (idx >= 0) db.app_settings[idx] = { ...payload };
            else db.app_settings.push({ ...payload });
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    markMessageAsRead: mocks.markMessageAsRead,
    sendReaction: mocks.sendReaction,
  },
}));

vi.mock("@/lib/manual-send-registry", () => ({
  registerWarmupSend: vi.fn(),
}));

vi.mock("../warmup-engine", () => ({
  logWarmupAction: mocks.logAction,
}));

import {
  getRandomWarmupVoiceBase64,
  uniquifyOggOpusBuffer,
  verifyOggPageCrc,
} from "../warmup-audio";
import { prunePhoneMemoryMap, type WarmupPhoneMemoryEntry } from "../warmup-phone-memory";
import {
  claimAndRunPendingWarmupAction,
  drainDuePendingWarmupActions,
  enqueuePendingWarmupAction,
  resetPendingWarmupActionsForTests,
} from "../warmup-pending-actions";

describe("Melhorias Aquecedor 2026: Ogg hash único, retenção de passaporte e fila persistente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.app_settings = [];
    resetPendingWarmupActionsForTests();
  });

  it("gera cópias Ogg Opus válidas com CRC-32 íntegro e SHA-256 diferente a cada disparo", () => {
    const samplePath = path.join(process.cwd(), "public", "warmup_voice_sample.ogg");
    const sampleBuf = fs.readFileSync(samplePath);
    const p1Offset = sampleBuf.indexOf("OggS", 4);

    expect(verifyOggPageCrc(sampleBuf, 0)).toBe(true);
    expect(verifyOggPageCrc(sampleBuf, p1Offset)).toBe(true);

    const copy1 = uniquifyOggOpusBuffer(sampleBuf, "seed_a_001");
    const copy2 = uniquifyOggOpusBuffer(sampleBuf, "seed_b_002");

    const hashOrig = crypto.createHash("sha256").update(sampleBuf).digest("hex");
    const hash1 = crypto.createHash("sha256").update(copy1).digest("hex");
    const hash2 = crypto.createHash("sha256").update(copy2).digest("hex");

    expect(hash1).not.toBe(hashOrig);
    expect(hash2).not.toBe(hashOrig);
    expect(hash1).not.toBe(hash2);

    // Ambas páginas iniciais preservam CRC-32 válido para decodificação no WhatsApp/WhatsApp Web
    expect(verifyOggPageCrc(copy1, 0)).toBe(true);
    expect(verifyOggPageCrc(copy1, p1Offset)).toBe(true);
    expect(verifyOggPageCrc(copy2, p1Offset)).toBe(true);

    const hashes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const b64 = getRandomWarmupVoiceBase64();
      expect(b64.length).toBeGreaterThan(1000);
      hashes.add(crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex"));
    }
    expect(hashes.size).toBe(6);
  });

  it("prunePhoneMemoryMap remove chips inativos > 120 dias e limita quantidade por tenant", () => {
    const now = Date.now();
    const oldIso = new Date(now - 130 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    const map: Record<string, WarmupPhoneMemoryEntry> = {
      "5511999990000": { lastActivityAt: oldIso, updatedAt: oldIso } as WarmupPhoneMemoryEntry,
      "5511999990001": { lastActivityAt: freshIso, updatedAt: new Date(now - 3000).toISOString() } as WarmupPhoneMemoryEntry,
      "5511999990002": { lastActivityAt: freshIso, updatedAt: new Date(now - 1000).toISOString() } as WarmupPhoneMemoryEntry,
      "5511999990003": { lastActivityAt: freshIso, updatedAt: new Date(now).toISOString() } as WarmupPhoneMemoryEntry,
    };

    const changed = prunePhoneMemoryMap(map, 2, 120, now);
    expect(changed).toBe(true);
    expect(map["5511999990000"]).toBeUndefined();
    expect(Object.keys(map).sort()).toEqual(["5511999990002", "5511999990003"]);
  });

  it("fila persistente de ações atrasadas evita perda pós-restart e nunca executa duas vezes", async () => {
    const now = Date.now();
    const dueItem = await enqueuePendingWarmupAction("tenant-w", {
      type: "read",
      dueAt: now - 1000,
      actorInstance: "chip-b",
      peerInstance: "chip-a",
      actorPhone: "5511988882222",
      peerPhone: "5511988881111",
      targetJid: "5511988881111@s.whatsapp.net",
      messageId: "msg-100",
      delayMs: 3500,
    });

    const futureItem = await enqueuePendingWarmupAction("tenant-w", {
      type: "react",
      dueAt: now + 30_000,
      actorInstance: "chip-b",
      peerInstance: "chip-a",
      actorPhone: "5511988882222",
      peerPhone: "5511988881111",
      targetJid: "5511988881111@s.whatsapp.net",
      messageId: "msg-100",
      delayMs: 30_000,
      emoji: "👍",
    });

    // Worker drena o item já vencido pós-restart; item futuro aguarda
    const drained = await drainDuePendingWarmupActions("tenant-w", now);
    expect(drained).toBe(1);
    expect(mocks.markMessageAsRead).toHaveBeenCalledTimes(1);
    expect(mocks.sendReaction).not.toHaveBeenCalled();

    // Se o timer em RAM disparar depois pro mesmo item já drenado, não repete
    const duplicateClaim = await claimAndRunPendingWarmupAction("tenant-w", dueItem.id);
    expect(duplicateClaim).toBe(false);
    expect(mocks.markMessageAsRead).toHaveBeenCalledTimes(1);

    // Timer do item futuro executa normalmente
    const futureClaim = await claimAndRunPendingWarmupAction("tenant-w", futureItem.id);
    expect(futureClaim).toBe(true);
    expect(mocks.sendReaction).toHaveBeenCalledTimes(1);
  });
});
