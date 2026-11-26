import { describe, expect, it } from "vitest";
import { detectBotOrUraLoop, shouldAutoPauseAfterClosing } from "../agent-guards";

describe("detectBotOrUraLoop", () => {
  it("detecta loop de URA/menu numérico após interação anterior da IA (cenário Líder Odonto 8082)", () => {
    const result = detectBotOrUraLoop({
      currentText:
        "Não entendemos sua mensagem. Digite uma opção válida:\n*1* - Financeiro\n*2* - Agendamento\nSeu ID: 98123",
      history: [
        { role: "model", content: "Oi, tudo bem? Montei uma prévia do site da clínica." },
        {
          role: "user",
          content:
            "Seja bem-vindo! Escolha uma das seguintes opções:\n1 - Recepção\n2 - Comercial\nSeu ID: 12001",
        },
        { role: "model", content: "Perfeito, poderia encaminhar para o responsável?" },
        {
          role: "user",
          content: "Não entendemos sua mensagem. Digite uma opção válida.\nSeu ID: 12001",
        },
      ],
    });

    expect(result).toEqual({
      isLoop: true,
      reason: "ura_or_auto_reply_repeated",
    });
  });

  it("não bloqueia primeira saudação automática quando ainda não houve loop", () => {
    const result = detectBotOrUraLoop({
      currentText:
        "Seja bem-vindo à Clínica Modelo! Nossa equipe já vai te atender. Escolha uma das opções:\n1 - Agendar\n2 - Orçamento",
      history: [{ role: "model", content: "Olá! Tudo bem?" }],
    });

    expect(result).toEqual({ isLoop: false, reason: null });
  });

  it("detecta saudação automática repetida após resposta da IA", () => {
    const autoGreeting =
      "Olá! Agradecemos o seu contato, em breve alguém da nossa equipe vai lhe atender.";
    const result = detectBotOrUraLoop({
      currentText: autoGreeting,
      history: [
        { role: "model", content: "Oi, vi que vocês ainda não têm site." },
        { role: "user", content: autoGreeting },
        { role: "model", content: "Sem problemas, fico no aguardo!" },
      ],
    });

    expect(result).toEqual({
      isLoop: true,
      reason: "ura_or_auto_reply_repeated",
    });
  });

  it("detecta loop de mensagem longa idêntica repetida 3+ vezes com IA no meio", () => {
    const repeatedMsg =
      "Por favor informe seu CPF para darmos continuidade ao protocolo automático.";
    const result = detectBotOrUraLoop({
      currentText: repeatedMsg,
      history: [
        { role: "model", content: "Oi! Tudo certo?" },
        { role: "user", content: repeatedMsg },
        { role: "model", content: "Sou da equipe de criação de sites." },
        { role: "user", content: repeatedMsg },
        { role: "model", content: "Posso mostrar uma prévia rápida?" },
      ],
    });

    expect(result).toEqual({
      isLoop: true,
      reason: "identical_customer_message_loop",
    });
  });

  it("não dispara falso positivo em conversa humana normal ou resposta curta repetida", () => {
    const result = detectBotOrUraLoop({
      currentText: "Pode enviar sim",
      history: [
        { role: "model", content: "Olá! Podemos mostrar uma prévia do site?" },
        { role: "user", content: "Pode enviar sim" },
        { role: "model", content: "Qual o melhor e-mail?" },
      ],
    });

    expect(result).toEqual({ isLoop: false, reason: null });
  });

  it("não dispara falso positivo quando a única ocorrência no histórico tem o mesmo message_id da mensagem atual (disparo em 2 partes)", () => {
    const autoGreeting =
      "Seja bem-vindo à Clínica! Agradecemos o seu contato, em breve alguém da nossa equipe vai lhe atender.";
    const result = detectBotOrUraLoop({
      currentText: autoGreeting,
      currentMessageId: "wamid-auto-1",
      history: [
        { role: "model", content: "Oi, tudo bem? Parte 1 do disparo" },
        { role: "user", content: autoGreeting, message_id: "wamid-auto-1" },
        { role: "model", content: "Parte 2 do disparo" },
      ],
    });

    expect(result).toEqual({ isLoop: false, reason: null });
  });
});

describe("shouldAutoPauseAfterClosing", () => {
  it("pausa após encerramento explícito da IA depois de recusa (cenário Villodonto 0202)", () => {
    const result = shouldAutoPauseAfterClosing({
      customerText: "Não tenho interesse no momento, obrigado.",
      assistantText:
        "Compreendo perfeitamente! Respeito totalmente sua decisão e não incomodaremos mais. Muito sucesso para vocês!",
    });

    expect(result).toEqual({
      shouldPause: true,
      reason: "explicit_closing",
    });
  });

  it("pausa após recusa do cliente seguida de despedida educada sem pergunta", () => {
    const result = shouldAutoPauseAfterClosing({
      customerText: "Já temos um site, não obrigado.",
      assistantText: "Entendido! Agradeço a atenção e desejo um ótimo dia.",
    });

    expect(result).toEqual({
      shouldPause: true,
      reason: "customer_refusal_closing",
    });
  });

  it("não pausa quando a IA ainda faz pergunta aberta ao cliente", () => {
    const result = shouldAutoPauseAfterClosing({
      customerText: "Agora não consigo ver.",
      assistantText:
        "Sem problemas! Tudo bem se eu te enviar o link para ver mais tarde?",
    });

    expect(result).toEqual({ shouldPause: false, reason: null });
  });

  it("não confunde 'não temos site' com recusa nem pausa quando há continuidade", () => {
    const result = shouldAutoPauseAfterClosing({
      customerText: "Ainda não temos site",
      assistantText: "Combinado! Já estou preparando uma demonstração para vocês.",
    });

    expect(result).toEqual({ shouldPause: false, reason: null });
  });

  it("nunca pausa em espera de fila/URA nem confunde auto-saudação de ausência com recusa (cenário Val Ar Condicionado)", () => {
    expect(
      shouldAutoPauseAfterClosing({
        customerText:
          "Val Ar Condicionado agradece contato. Horário de funcionamento de segunda a sexta 09h - 18h.",
        assistantText: "Combinado, fico no aguardo por aqui!",
      }),
    ).toEqual({ shouldPause: false, reason: null });

    expect(
      shouldAutoPauseAfterClosing({
        customerText: "No momento não estamos atendendo, responderemos em breve.",
        assistantText: "Entendido, fico à disposição e desejo um ótimo dia.",
      }),
    ).toEqual({ shouldPause: false, reason: null });
  });
});

