/**
 * Testes determinísticos dos registros in-memory de envio manual/IA.
 * São Map globais com TTL de 2 min — sem DB, sem rede.
 *
 * Cobrem o coração do disambiguation do webhook:
 *   - registerManualSend/isManualSend: msg enviada pelo painel世人 não vira 'ai'
 *   - registerAiSend/isAiSend: msg da IA não dispara pausa humana
 *   - registerPendingAutomatedSend/isPendingAutomatedSend: race-condition
 *     quando o echo do webhook chega ANTES de salvarmos no DB
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerManualSend,
  isManualSend,
  registerAiSend,
  isAiSend,
  registerPendingAutomatedSend,
  isPendingAutomatedSend,
} from "../manual-send-registry";

// Limpa os Maps globais antes de cada teste — senão estado vaza entre casos.
beforeEach(() => {
  globalThis.__manualSendRegistry?.clear();
  globalThis.__aiSendRegistry?.clear();
  globalThis.__pendingAutomatedSends?.clear();
});

describe("Manual send registry (painel → humano, não IA)", () => {
  it("msgId registrado é reconhecido como manual", () => {
    registerManualSend("msg-manual-1");
    expect(isManualSend("msg-manual-1")).toBe(true);
  });

  it("msgId não registrado NÃO é manual", () => {
    expect(isManualSend("msg-nao-registrado")).toBe(false);
  });

  it("string vazia não registra e não encontra", () => {
    registerManualSend("");
    expect(isManualSend("")).toBe(false);
  });

  it("segundo registro do mesmo msgId não duplica entrada (sobrescreve)", () => {
    registerManualSend("dup-1");
    registerManualSend("dup-1");
    expect(isManualSend("dup-1")).toBe(true);
  });
});

describe("AI send registry (IA → não pausa ao ouvir próprio echo)", () => {
  it("msgId da IA é reconhecido", () => {
    registerAiSend("ai-msg-1");
    expect(isAiSend("ai-msg-1")).toBe(true);
  });

  it("msgId qualquer não é da IA", () => {
    expect(isAiSend("qualquer")).toBe(false);
  });

  it("registros de IA e manual são independentes", () => {
    registerManualSend("m1");
    registerAiSend("a1");
    expect(isManualSend("m1")).toBe(true);
    expect(isAiSend("m1")).toBe(false);
    expect(isAiSend("a1")).toBe(true);
    expect(isManualSend("a1")).toBe(false);
  });
});

describe("Pending automated send (race-condition echo)", () => {
  it("intenção pendente bate por instance+jid+texto normalizado", () => {
    registerPendingAutomatedSend("inst1", "5511@s.whatsapp.net", "Olá!");
    expect(isPendingAutomatedSend("inst1", "5511@s.whatsapp.net", "Olá!")).toBe(true);
  });

  it("texto é normalizado (case/whitespace/punctuation irrelevantes)", () => {
    registerPendingAutomatedSend("inst1", "5511@s.whatsapp.net", "Boa Tarde!");
    // text com variação de maiúsculas e espaços ainda bate
    expect(isPendingAutomatedSend("inst1", "5511@s.whatsapp.net", "boa  tarde")).toBe(true);
  });

  it("jid com @s.whatsapp.net vs sem — equivalente (cleanJid)", () => {
    registerPendingAutomatedSend("inst1", "55119999@s.whatsapp.net", "oi");
    expect(isPendingAutomatedSend("inst1", "55119999", "oi")).toBe(true);
  });

  it("instance errada não bate", () => {
    registerPendingAutomatedSend("inst1", "5511", "oi");
    expect(isPendingAutomatedSend("inst2", "5511", "oi")).toBe(false);
  });

  it("texto diferente não bate", () => {
    registerPendingAutomatedSend("inst1", "5511", "msg A");
    expect(isPendingAutomatedSend("inst1", "5511", "msg B")).toBe(false);
  });

  it("consumo é destrutivo — segunda chamada retorna false", () => {
    registerPendingAutomatedSend("inst1", "5511", "oi");
    expect(isPendingAutomatedSend("inst1", "5511", "oi")).toBe(true);
    expect(isPendingAutomatedSend("inst1", "5511", "oi")).toBe(false);
  });

  it("campos faltando → não registra e não encontra", () => {
    registerPendingAutomatedSend("", "5511", "oi");
    expect(isPendingAutomatedSend("", "5511", "oi")).toBe(false);
    registerPendingAutomatedSend("inst1", "", "oi");
    expect(isPendingAutomatedSend("inst1", "", "oi")).toBe(false);
    registerPendingAutomatedSend("inst1", "5511", "");
    expect(isPendingAutomatedSend("inst1", "5511", "")).toBe(false);
  });
});
