import { describe, it, expect } from "vitest";

import { sanitizeLogPayload } from "@/app/api/webhooks/shared-helpers";

describe("sanitizeLogPayload — webhook_logs sem base64/strings gigantes", () => {
  it("remove chaves com base64 em qualquer nível", () => {
    const payload = {
      event: "messages.upsert",
      data: {
        message: {
          imageMessage: { base64: "AAAA".repeat(1000), mimetype: "image/jpeg" },
          audioMessage: { BASE64_DATA: "zzzz", url: "https://x" },
        },
      },
    };
    const out = sanitizeLogPayload(payload) as any;
    // Blob fora, metadado fica
    expect(out.data.message.imageMessage.base64).toBeUndefined();
    expect(out.data.message.imageMessage.mimetype).toBe("image/jpeg");
    expect(out.data.message.audioMessage.BASE64_DATA).toBeUndefined();
    expect(out.data.message.audioMessage.url).toBe("https://x");
    expect(out.event).toBe("messages.upsert");
  });

  it("trunca strings longas mantendo marcador de tamanho", () => {
    const big = "x".repeat(5000);
    const out = sanitizeLogPayload({ s: big }) as any;
    expect(typeof out.s).toBe("string");
    expect(out.s.length).toBeLessThan(2100);
    expect(out.s).toContain("(+3000)");
  });

  it("limita arrays e profundidade", () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ i }));
    const out = sanitizeLogPayload({ arr }) as any;
    expect(out.arr).toHaveLength(20);

    // 12 níveis aninhados → a partir da profundidade 6 vira marcador
    let deep: any = { v: "leaf" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    const serialized = JSON.stringify(sanitizeLogPayload(deep));
    expect(serialized).toContain('"[profundidade]"');
    expect(serialized).not.toContain("leaf");
  });

  it("preserva primitivos e null", () => {
    expect(sanitizeLogPayload(null)).toBeNull();
    expect(sanitizeLogPayload(42)).toBe(42);
    expect(sanitizeLogPayload("ok")).toBe("ok");
  });
});
