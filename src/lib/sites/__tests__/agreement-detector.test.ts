import { describe, expect, it, vi } from "vitest";
import {
  evaluatePreviewAgreement,
  DEFAULT_SITE_PREVIEW_EVAL_PROMPT,
  DEFAULT_SITE_PREVIEW_PING_MESSAGE,
} from "../agreement-detector";
import * as aiProvider from "@/lib/ai-provider";

describe("agreement-detector (Avaliador de Aceite de Prévia)", () => {
  it("possui templates padrão bem formatados e completos", () => {
    expect(DEFAULT_SITE_PREVIEW_EVAL_PROMPT).toContain("aceitou");
    expect(DEFAULT_SITE_PREVIEW_EVAL_PROMPT).toContain("JSON");
    expect(DEFAULT_SITE_PREVIEW_PING_MESSAGE).toContain("{{nome_negocio}}");
    expect(DEFAULT_SITE_PREVIEW_PING_MESSAGE).toContain("celular na mão");
  });

  it("retorna false e confiança baixa se não houver mensagens", async () => {
    const res = await evaluatePreviewAgreement({ messages: [] });
    expect(res.agreed).toBe(false);
    expect(res.confidence).toBe("baixa");
  });

  it("descarta imediatamente sem chamar IA quando o cliente diz não / recusa", async () => {
    const generateSpy = vi.spyOn(aiProvider, "generateText");

    const res = await evaluatePreviewAgreement({
      messages: [
        { role: "agent", content: "Podemos fazer uma prévia gratuita do seu site?" },
        { role: "user", content: "Não, obrigado. Não tenho interesse." },
      ],
    });

    expect(res.agreed).toBe(false);
    expect(res.confidence).toBe("alta");
    expect(res.evaluatorMethod).toBe("heuristic_fallback");
    expect(generateSpy).not.toHaveBeenCalled();
    generateSpy.mockRestore();
  });

  it("detecta concordância via IA leve quando o cliente aceita", async () => {
    const generateSpy = vi.spyOn(aiProvider, "generateText").mockResolvedValueOnce({
      text: JSON.stringify({ aceitou: true, confianca: "alta", motivo: "cliente autorizou o envio" }),
      usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
    } as any);

    const res = await evaluatePreviewAgreement({
      messages: [
        { role: "agent", content: "Posso montar um modelo gratuito pro seu negócio e te mandar?" },
        { role: "user", content: "Pode sim, manda aí para eu ver!" },
      ],
    });

    expect(res.agreed).toBe(true);
    expect(res.confidence).toBe("alta");
    expect(res.evaluatorMethod).toBe("ai");
    expect(res.tokensUsed).toBe(45);
    generateSpy.mockRestore();
  });

  it("aciona fallback heurístico se a IA falhar ou lançar erro", async () => {
    const generateSpy = vi.spyOn(aiProvider, "generateText").mockRejectedValueOnce(new Error("API Timeout"));

    const res = await evaluatePreviewAgreement({
      messages: [
        { role: "agent", content: "Quer que a gente monte uma prévia?" },
        { role: "user", content: "Show, pode criar sim!" },
      ],
    });

    expect(res.agreed).toBe(true);
    expect(res.evaluatorMethod).toBe("heuristic_fallback");
    generateSpy.mockRestore();
  });

  it("retorna false se o cliente apenas fez perguntas e a IA não classificou como aceite", async () => {
    const generateSpy = vi.spyOn(aiProvider, "generateText").mockResolvedValueOnce({
      text: JSON.stringify({ aceitou: false, confianca: "alta", motivo: "cliente apenas perguntou o preço" }),
      usage: { promptTokens: 28, completionTokens: 12, totalTokens: 40 },
    } as any);

    const res = await evaluatePreviewAgreement({
      messages: [
        { role: "agent", content: "Podemos montar um site novo para vocês." },
        { role: "user", content: "Mas quanto custa a mensalidade disso?" },
      ],
    });

    expect(res.agreed).toBe(false);
    expect(res.evaluatorMethod).toBe("ai");
    generateSpy.mockRestore();
  });
});
