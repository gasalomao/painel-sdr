/**
 * Testa o saneamento de número no Evolution V2 (evolution.ts sendMedia).
 *
 * Cobertura:
 *  - Prefixo phone: removido (bug histórico causava HTTP 400 no envio manual).
 *  - JID completo preservado se já tiver sufixo válido.
 *  - Número nu vira JID @s.whatsapp.net.
 *
 * Mock: axios como função default (evolution.ts chama axios({...})).
 * Sem rede real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const axiosMock = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({
  default: axiosMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        in: () => ({ data: null }),
      }),
    }),
  }),
}));

describe("Evolution V2 — saneamento no sendMedia", () => {
  beforeEach(() => {
    axiosMock.mockReset();
    axiosMock.mockResolvedValue({ data: { key: { id: "m" } } });
    vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
    vi.stubEnv("EVOLUTION_API_KEY", "k");
    vi.stubEnv("EVOLUTION_INSTANCE", "inst1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("remove prefixo phone: antes de montar targetJid", async () => {
    const { evolution } = await import("../evolution");
    await evolution.sendMedia(
      "phone:5511991927253",
      "legenda",
      { type: "image", base64: "data:image/png;base64," + "x".repeat(200) },
      "inst1"
    );

    const callArgs = axiosMock.mock.calls[0][0];
    const body = typeof callArgs.data === "string" ? JSON.parse(callArgs.data) : callArgs.data;
    expect(body.number).toBe("5511991927253@s.whatsapp.net");
    expect(body.number).not.toContain("phone:");
  });

  it("preserva JID de grupo @g.us sem adicionar @s.whatsapp.net", async () => {
    const { evolution } = await import("../evolution");
    await evolution.sendMedia(
      "120363xxx@g.us",
      "alo",
      { type: "image", base64: "data:image/png;base64," + "x".repeat(200) },
      "inst1"
    );

    const callArgs = axiosMock.mock.calls[0][0];
    const body = typeof callArgs.data === "string" ? JSON.parse(callArgs.data) : callArgs.data;
    expect(body.number).toBe("120363xxx@g.us");
  });

  it("número puro vira JID @s.whatsapp.net", async () => {
    const { evolution } = await import("../evolution");
    await evolution.sendMedia(
      "5511991927253",
      "",
      { type: "image", base64: "data:image/png;base64," + "x".repeat(200) },
      "inst1"
    );

    const callArgs = axiosMock.mock.calls[0][0];
    const body = typeof callArgs.data === "string" ? JSON.parse(callArgs.data) : callArgs.data;
    expect(body.number).toBe("5511991927253@s.whatsapp.net");
  });
});
