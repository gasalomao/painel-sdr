import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateTypingDelaySeconds,
  calculateTypingDelayMs,
  normalizeTypingDelayConfig,
  DEFAULT_TYPING_DELAY_CONFIG,
} from "../agent-delay";

describe("Cálculo e Normalização de Delay de Digitação (Evolution API)", () => {
  it("retorna os valores padrão quando nenhum objeto é fornecido", () => {
    const config = normalizeTypingDelayConfig(null);
    expect(config.mode).toBe("random");
    expect(config.fixedSeconds).toBe(10);
    expect(config.minSeconds).toBe(5);
    expect(config.maxSeconds).toBe(25);
  });

  it("calcula delay no Modo Fixo retornando exatamente os segundos configurados", () => {
    const delaySec = calculateTypingDelaySeconds({
      mode: "fixed",
      fixedSeconds: 15,
      minSeconds: 5,
      maxSeconds: 25,
    });
    expect(delaySec).toBe(15);

    const delayMs = calculateTypingDelayMs({
      mode: "fixed",
      fixedSeconds: 15,
    });
    expect(delayMs).toBe(15000);
  });

  it("calcula delay no Modo Aleatório sorteando sempre dentro da faixa [min, max]", () => {
    const min = 5;
    const max = 25;
    for (let i = 0; i < 100; i++) {
      const delay = calculateTypingDelaySeconds({
        mode: "random",
        minSeconds: min,
        maxSeconds: max,
      });
      expect(delay).toBeGreaterThanOrEqual(min);
      expect(delay).toBeLessThanOrEqual(max);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it("protege contra max menor que min e valores negativos ou nulos", () => {
    const config = normalizeTypingDelayConfig({
      mode: "random",
      minSeconds: 20,
      maxSeconds: 10,
    });
    expect(config.minSeconds).toBe(20);
    expect(config.maxSeconds).toBe(20); // ajustado automaticamente

    const delay = calculateTypingDelaySeconds({
      mode: "random",
      minSeconds: 20,
      maxSeconds: 10,
    });
    expect(delay).toBe(20);
  });
});

describe("Integração do Delay com Evolution API (v2 e Go)", () => {
  const axiosMock = vi.hoisted(() => vi.fn());
  vi.mock("axios", () => ({ default: axiosMock }));

  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { key: { id: "msg-123" } } });
    vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
    vi.stubEnv("EVOLUTION_API_KEY", "test-key");
    vi.stubEnv("EVOLUTION_INSTANCE", "inst-delay-test");
  });

  it("evolution.sendMessage repassa o delay para o endpoint /message/sendText", async () => {
    const { evolution } = await import("../evolution");
    await evolution.sendMessage("5511991702108", "Olá com delay!", "inst-delay-test", { delay: 14000 });

    expect(axiosMock).toHaveBeenCalled();
    const sendTextCall = axiosMock.mock.calls.find((call) => call[0].url.includes("/message/sendText"));
    expect(sendTextCall).toBeDefined();

    const body = typeof sendTextCall[0].data === "string" ? JSON.parse(sendTextCall[0].data) : sendTextCall[0].data;
    expect(body.delay).toBe(14000);
    expect(body.text).toBe("Olá com delay!");
    expect(body.number).toBe("5511991702108@s.whatsapp.net");
  });

  it("evolutionGo.sendText repassa o delay para o payload de envio", async () => {
    vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
    vi.stubEnv("EVOLUTION_GO_KEY", "go-key");

    const goFetchMock = vi.fn().mockImplementation(async (url: string) => {
      return {
        ok: true,
        json: async () => ({ key: { id: "go-delay-123" } }),
      };
    });
    vi.stubGlobal("fetch", goFetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    await evolutionGo.sendText("5511991702108@s.whatsapp.net", "Mensagem Go", "go-inst", { delay: 12000 });

    const sendTextCall = goFetchMock.mock.calls.find((c) => String(c[0]).includes("/send/text"));
    expect(sendTextCall).toBeDefined();
    const sentBody = JSON.parse(sendTextCall[1].body);
    expect(sentBody.delay).toBe(12000);
    expect(sentBody.text).toBe("Mensagem Go");
  });
});
