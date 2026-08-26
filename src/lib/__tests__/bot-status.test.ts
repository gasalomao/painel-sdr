/**
 * Testa helpers de limpeza de números de telefone (manual-send-registry).
 *
 * POR QUE EXISTE: o registro de "mensagens enviadas manualmente" precisa
 * deduplicar por destino. A chave inclui o JID limpo. Se a limpeza falhar,
 * mesmo número vira 2 chaves → registros duplicados → IA responde mesmo
 * após humano enviar (bug de "conversa não pausa").
 */
import { describe, it, expect } from "vitest";

// Replica a lógica do manual-send-registry (chaves limpas remoteJid@instance)
function buildRegistryKey(remoteJid: string, instanceName: string, channel: string): string {
  const cleanJid = remoteJid.replace("@s.whatsapp.net", "").trim();
  const norm = channel.toLowerCase();
  return `${instanceName}:${cleanJid}:${norm}`;
}

describe("manual-send-registry — chave de deduplicação", () => {
  it("chaves idênticas geram idênticas", () => {
    const k1 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst1", "whatsapp");
    const k2 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst1", "whatsapp");
    expect(k1).toBe(k2);
  });

  it("JIDs diferentes geram chaves diferentes", () => {
    const k1 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst1", "whatsapp");
    const k2 = buildRegistryKey("5511888887777@s.whatsapp.net", "inst1", "whatsapp");
    expect(k1).not.toBe(k2);
  });

  it("instâncias diferentes geram chaves diferentes", () => {
    const k1 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst1", "whatsapp");
    const k2 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst2", "whatsapp");
    expect(k1).not.toBe(k2);
  });

  it("canal case-insensitive (WhatsApp == whatsapp)", () => {
    const k1 = buildRegistryKey("5511@s.whatsapp.net", "i", "whatsapp");
    const k2 = buildRegistryKey("5511@s.whatsapp.net", "i", "WHATSAPP");
    expect(k1).toBe(k2);
  });

  it("JID sem sufixo @s.whatsapp.net também funciona", () => {
    const k1 = buildRegistryKey("5511991927253", "inst1", "whatsapp");
    const k2 = buildRegistryKey("5511991927253@s.whatsapp.net", "inst1", "whatsapp");
    // Sem sufixo: a chave NÃO tem o sufixo; com sufixo: o replace tira.
    // Ambas devem dar a mesma chave final.
    expect(k1).toBe(k2);
  });
});

describe("manual-send-registry — edge cases", () => {
  it("JID de grupo @g.us não é limpo (mantém formato completo)", () => {
    const key = buildRegistryKey("120363@g.us", "inst1", "whatsapp");
    expect(key).toContain("120363@g.us");
  });

  it("JID vazio não explode", () => {
    expect(() => buildRegistryKey("", "inst1", "whatsapp")).not.toThrow();
    const key = buildRegistryKey("", "inst1", "whatsapp");
    expect(key).toBe("inst1::whatsapp");
  });
});

// ============================================================================
// BOT-STATUS DE VERDADE — sanitização da ordem de modelos + whitelist do
// método + cache TTL/invalidação. (Antes este arquivo nem importava o módulo.)
// ============================================================================
import { describe as d2, it as t2, expect as e2, vi, beforeEach as bfe } from "vitest";

let maybeSingleResult: { data: unknown } = { data: null };
const maybeSingleSpy = vi.fn(async () => maybeSingleResult);

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingleSpy,
          single: vi.fn(async () => ({ data: null })),
        })),
      })),
    })),
  },
}));

d2("bot-status — getTranscriptionModels (ordem salva por agente)", () => {
  bfe(() => {
    vi.clearAllMocks();
    vi.resetModules();
    maybeSingleResult = { data: null };
  });

  t2("sem agente → [] sem consultar banco", async () => {
    const { getTranscriptionModels } = await import("@/lib/bot-status");
    e2(await getTranscriptionModels(null)).toEqual([]);
    e2(await getTranscriptionModels(undefined)).toEqual([]);
    e2(maybeSingleSpy).not.toHaveBeenCalled();
  });

  t2("options ausente/não-array → []", async () => {
    maybeSingleResult = { data: { options: { gemini_api_key: "x" } } };
    const { getTranscriptionModels } = await import("@/lib/bot-status");
    e2(await getTranscriptionModels(1)).toEqual([]);
    maybeSingleResult = { data: { options: { transcription_models: "não-sou-array" } } };
    // outro agentId força nova leitura (cache é por agente)
    e2(await getTranscriptionModels(2)).toEqual([]);
  });

  t2("lê array válido, converte pra string, descarta vazios e corta em 10", async () => {
    maybeSingleResult = {
      data: {
        options: {
          transcription_models: [
            "modelo/a",
            42,               // número vira string
            "",               // vazio fora
            "   ",            // só espaço fora
            null,             // null fora
            ...Array.from({ length: 12 }, (_, i) => `extra/${i}`),
          ],
        },
      },
    };
    const { getTranscriptionModels } = await import("@/lib/bot-status");
    const out = await getTranscriptionModels(3);
    e2(out[0]).toBe("modelo/a");
    e2(out[1]).toBe("42");
    e2(out.length).toBe(10); // cap
    e2(out.some((s: unknown) => s === "" || s === null)).toBe(false);
  });

  t2("cache: 2ª chamada no mesmo agente NÃO consulta banco; invalidação volta a consultar", async () => {
    maybeSingleResult = { data: { options: { transcription_models: ["a/b"] } } };
    const { getTranscriptionModels, invalidateTranscriptionModelsCache } = await import("@/lib/bot-status");
    e2(await getTranscriptionModels(7)).toEqual(["a/b"]);
    const afterCache = maybeSingleSpy.mock.calls.length;
    e2(await getTranscriptionModels(7)).toEqual(["a/b"]);
    e2(maybeSingleSpy.mock.calls.length).toBe(afterCache); // cache hit

    invalidateTranscriptionModelsCache(7);
    e2(await getTranscriptionModels(7)).toEqual(["a/b"]);
    e2(maybeSingleSpy.mock.calls.length).toBe(afterCache + 1); // reconsultou
  });

  t2("getTranscriptionMethod: aceita openrouter; valores estranhos caem em auto", async () => {
    maybeSingleResult = { data: { transcription_method: "openrouter" } };
    const mod = await import("@/lib/bot-status");
    e2(await mod.getTranscriptionMethod(11)).toBe("openrouter");

    maybeSingleResult = { data: { transcription_method: "HACK" } };
    e2(await mod.getTranscriptionMethod(12)).toBe("auto");

    maybeSingleResult = { data: null };
    e2(await mod.getTranscriptionMethod(13)).toBe("auto");

    e2(await mod.getTranscriptionMethod(null)).toBe("auto");
    const callsAfterNull = maybeSingleSpy.mock.calls.length;
    await mod.getTranscriptionMethod(null);
    e2(maybeSingleSpy.mock.calls.length).toBe(callsAfterNull); // null short-circuit sem banco
  });
});
