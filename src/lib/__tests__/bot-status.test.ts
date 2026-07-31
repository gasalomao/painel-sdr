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
