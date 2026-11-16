import { describe, expect, it } from "vitest";
import {
  dropTrailingCurrentMessage,
  historyMessageContent,
  historyRole,
  senderPrefix,
  stripMediaUrls,
  toGeminiTurns,
  truncateHistoryMessage,
  windowHistory,
} from "../agent-history";

describe("stripMediaUrls", () => {
  it("troca marcador de imagem por texto curto", () => {
    expect(stripMediaUrls("[IMAGEM: https://cdn.exemplo.com/a.jpg]")).toBe("[foto enviada]");
  });

  it("troca markdown de imagem por texto curto", () => {
    expect(stripMediaUrls("veja ![](https://cdn.exemplo.com/b.png) agora")).toBe(
      "veja [foto enviada] agora",
    );
  });

  it("nao mexe em texto sem midia", () => {
    expect(stripMediaUrls("quero um orcamento")).toBe("quero um orcamento");
  });
});

describe("truncateHistoryMessage", () => {
  it("mantem mensagem curta intacta", () => {
    expect(truncateHistoryMessage("oi")).toBe("oi");
  });

  it("corta acima do limite e sinaliza", () => {
    const out = truncateHistoryMessage("a".repeat(700), 600);
    expect(out.length).toBe(600 + "... [cortado]".length);
    expect(out.endsWith("... [cortado]")).toBe(true);
  });
});

describe("historyMessageContent", () => {
  it("usa marcador quando nao ha conteudo", () => {
    expect(historyMessageContent({ content: null })).toBe("[Mídia/Comando]");
  });

  it("aplica sanitizacao e corte", () => {
    const out = historyMessageContent({
      content: `[IMAGEM: https://x/y.jpg]${"b".repeat(700)}`,
    });
    expect(out.startsWith("[foto enviada]")).toBe(true);
    expect(out.endsWith("... [cortado]")).toBe(true);
  });
});

describe("historyRole / senderPrefix", () => {
  it("customer vira user, resto vira model", () => {
    expect(historyRole({ sender_type: "customer" })).toBe("user");
    expect(historyRole({ sender_type: "ai" })).toBe("model");
    expect(historyRole({ sender_type: "customer", _skip_marker: true })).toBe("model");
  });

  it("marca atendente humano", () => {
    expect(senderPrefix({ sender_type: "human" })).toBe("[Atendente Humano da Empresa]: ");
    expect(senderPrefix({ sender_type: "customer" })).toBe("");
  });
});

describe("dropTrailingCurrentMessage", () => {
  const msg = (content: string, sender_type = "customer") => ({ content, sender_type });

  it("remove a copia da mensagem atual", () => {
    const out = dropTrailingCurrentMessage([msg("oi"), msg("quero preco")], "quero preco");
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("oi");
  });

  it("nao remove quando o conteudo difere", () => {
    const out = dropTrailingCurrentMessage([msg("oi"), msg("quero preco")], "outra coisa");
    expect(out).toHaveLength(2);
  });

  it("fora de lote remove no maximo uma ocorrencia repetida", () => {
    const out = dropTrailingCurrentMessage([msg("ok"), msg("ok")], "ok", false);
    expect(out).toHaveLength(1);
  });

  it("em lote remove todas as ocorrencias que compoem o texto", () => {
    const out = dropTrailingCurrentMessage([msg("oi"), msg("ok"), msg("ok")], "oi\nok\nok", true);
    expect(out).toHaveLength(0);
  });
});

describe("windowHistory", () => {
  const conv = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sender_type: i % 2 === 0 ? "customer" : "ai", content: `m${i}` }));

  it("conversa curta passa intacta", () => {
    const out = windowHistory(conv(10), { middleContent: "x" });
    expect(out.skipped).toBe(0);
    expect(out.messages).toHaveLength(10);
  });

  it("mantem cabeca e cauda com marcador no meio", () => {
    const out = windowHistory(conv(30), { keepHead: 3, keepTail: 12, middleContent: "[resumo]" });
    expect(out.skipped).toBe(15);
    expect(out.messages).toHaveLength(16);
    expect(out.messages[3]._skip_marker).toBe(true);
    expect(out.messages[3].content).toBe("[resumo]");
  });
});

describe("toGeminiTurns", () => {
  it("comeca com user quando o primeiro turno e do modelo", () => {
    const out = toGeminiTurns([{ role: "model", parts: [{ text: "ola" }] }]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("model");
  });

  it("funde turnos consecutivos do mesmo papel", () => {
    const out = toGeminiTurns([
      { role: "user", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "b" }] },
      { role: "model", parts: [{ text: "c" }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].parts[0].text).toBe("a\n\nb");
  });
});
