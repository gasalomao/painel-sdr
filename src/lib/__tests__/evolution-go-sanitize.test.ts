/**
 * Testa o saneamento de número de telefone do Evolution GO (formatNumberForGo).
 *
 * POR QUE EXISTE: o bug "envio manual falha com phone:5511..." foi corrigido
 * vitalmente em 2026-07-23 — o GO rejeitava JIDs com prefixo phone: e sufixo
 * @s.whatsapp.net. Se essa função quebrar, todos os envios manuais pelo /chat
 * quebram silenciosamente (mensagem salva no DB mas não entregue no WhatsApp).
 *
 * Como formatNumberForGo não é exportada, testamos via comportamento público:
 * mandamos um JID "sujo" e verificamos que o payload de fetch tem o número limpo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: null,
}));

describe("Evolution GO — saneamento de número (formatNumberForGo)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
    vi.stubEnv("EVOLUTION_GO_KEY", "k");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("limpa prefixo phone:, sufixo @s.whatsapp.net e não-dígitos", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "msg_1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    const res = await evolutionGo.sendText("phone:5511991927253@s.whatsapp.net", "oi", "inst1");

    expect(res.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.number).toBe("5511991927253");
    expect(body.number).not.toContain("phone:");
    expect(body.number).not.toContain("@");
  });

  it("preserva JID de grupo (@g.us) intacto", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "msg_g" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    await evolutionGo.sendText("120363xxx@g.us", "alo grupo", "inst1");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.number).toBe("120363xxx@g.us");
  });

  it("rejeita número vazio com erro explícito (não manda payload inválido)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    const res = await evolutionGo.sendText("", "oi", "inst1");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/inválido/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lida com número só com dígitos (already clean) sem alterar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "m" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    await evolutionGo.sendText("5511991927253", "oi", "inst1");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.number).toBe("5511991927253");
  });

  it("rejeita string com letras misturadas — limpa não-dígitos", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: { id: "m" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { evolutionGo } = await import("../providers/evolution-go");
    await evolutionGo.sendText("phone:+55 (11) 99192-7253", "oi", "inst1");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.number).toBe("5511991927253");
  });
});
