/**
 * Testa a fachada channel.ts (roteamento V2/GO/Cloud + cleanNumber do Cloud).
 *
 * POR QUE EXISTE: o channel.ts é o PONTO ÚNICO onde todos os envios passam.
 * Se o cleanNumber do Cloud falhar, envios vão pra Meta com payload inválido.
 * Testa via axios mock (whatsappCloud usa axios internamente).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

import axios from "axios";

describe("whatsapp-cloud — saneamento para Meta API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("envia só dígitos (limpa +, parênteses, espaços, traços)", async () => {
    (axios.post as any).mockResolvedValue({ data: { messaging_product: "whatsapp" } });

    const { whatsappCloud } = await import("../whatsapp-cloud");
    await whatsappCloud.sendText(
      { phone_number_id: "123", access_token: "tok" },
      "+55 (11) 99192-7253",
      "oi"
    );

    const body = (axios.post as any).mock.calls[0][1];
    expect(body.to).toBe("5511991927253");
    expect(body.to).not.toContain("+");
    expect(body.to).not.toContain(" ");
  });

  it("limpa prefixo phone:", async () => {
    (axios.post as any).mockResolvedValue({ data: { messaging_product: "whatsapp" } });

    const { whatsappCloud } = await import("../whatsapp-cloud");
    await whatsappCloud.sendText(
      { phone_number_id: "123", access_token: "tok" },
      "phone:5511991927253",
      "oi"
    );

    const body = (axios.post as any).mock.calls[0][1];
    expect(body.to).toBe("5511991927253");
  });

  it("remove sufixo @s.whatsapp.net (formato JID interno)", async () => {
    (axios.post as any).mockResolvedValue({ data: { messaging_product: "whatsapp" } });

    const { whatsappCloud } = await import("../whatsapp-cloud");
    await whatsappCloud.sendText(
      { phone_number_id: "123", access_token: "tok" },
      "5511991927253@s.whatsapp.net",
      "oi"
    );

    const body = (axios.post as any).mock.calls[0][1];
    expect(body.to).toBe("5511991927253");
    expect(body.to).not.toContain("@");
  });

  it("não add sufixo @ (Meta API recebe número cru)", async () => {
    (axios.post as any).mockResolvedValue({ data: { messaging_product: "whatsapp" } });

    const { whatsappCloud } = await import("../whatsapp-cloud");
    await whatsappCloud.sendText(
      { phone_number_id: "123", access_token: "tok" },
      "5511991927253",
      "oi"
    );

    const body = (axios.post as any).mock.calls[0][1];
    expect(body.to).toBe("5511991927253");
    expect(body.to).not.toContain("@");
  });

  it("preserva msgProduct e formato Meta no payload", async () => {
    (axios.post as any).mockResolvedValue({ data: { messaging_product: "whatsapp" } });

    const { whatsappCloud } = await import("../whatsapp-cloud");
    await whatsappCloud.sendText(
      { phone_number_id: "123", access_token: "tok" },
      "5511991927253",
      "oi"
    );

    const body = (axios.post as any).mock.calls[0][1];
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("oi");
  });
});
