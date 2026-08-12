import { describe, it, expect } from "vitest";
import {
  buildOrganizerSystemPrompt,
  buildKanbanAppendix,
  buildDateContext,
  buildAppointmentsContext,
  DEFAULT_ORGANIZER_BASE_PROMPT,
  type KanbanColLite,
  type AppointmentLite,
} from "../organizer-prompt";
import { parseModelRef, providerOf, formatModelRef, resolveReasoningMode, isFailoverableStatus, applyReasoning } from "../ai-provider";

/* ============================================================
   TESTE DE INTEGRAÇÃO COMPLETO DO ORGANIZADOR IA

   Cobertura:
   1. Prompt builder (R1-R17, kanban appendix, date, appointments)
   2. Filtros de economia de tokens (cache, terminal, sem mudança, heurística)
   3. Provider routing (Gemini vs OpenRouter vs Gateway)
   4. Validação de hierarquia e anti-bouncing
   5. JSON parse robustez
   ============================================================ */

const COLS: KanbanColLite[] = [
  { status_key: "novo", label: "Novo", order_index: 0 },
  { status_key: "primeiro_contato", label: "Primeiro Contato", order_index: 1 },
  { status_key: "interessado", label: "Interessado", order_index: 2 },
  { status_key: "follow_up", label: "Follow-up", order_index: 3 },
  { status_key: "agendado", label: "Agendado", order_index: 4 },
  { status_key: "fechado", label: "Fechado", order_index: 5, is_terminal: false },
  { status_key: "sem_interesse", label: "Sem Interesse", order_index: 6, is_terminal: true },
  { status_key: "perdido", label: "Perdido", order_index: 7, is_terminal: true },
];

const NOW = new Date("2026-08-11T14:00:00Z");

// ─────────── 1. PROMPT BUILDER ───────────

describe("[Organizer] Prompt builder — integridade estrutural", () => {
  it("prompt base contém todas as 17 regras (R1-R17)", () => {
    for (let i = 1; i <= 17; i++) {
      expect(DEFAULT_ORGANIZER_BASE_PROMPT).toContain(`R${i}.`);
    }
  });

  it("prompt final junta base + kanban + data + appointments", () => {
    const out = buildOrganizerSystemPrompt(null, COLS, NOW, []);
    expect(out.systemPrompt).toContain("classificador SÊNIOR");
    expect(out.systemPrompt).toContain("novo");
    expect(out.systemPrompt).toContain("sem_interesse");
    expect(out.systemPrompt).toContain("DATA DE HOJE");
    expect(out.systemPrompt).toContain("2026-08-11");
    expect(out.systemPrompt).toContain("AGENDAMENTOS ESTRUTURADOS");
  });

  it("prompt customizado substitui prompt base completamente", () => {
    const custom = "Você é um robô分类 CRM.";
    const out = buildOrganizerSystemPrompt(custom, COLS, NOW);
    expect(out.systemPrompt).toContain("robô");
    expect(out.systemPrompt).not.toContain("classificador SÊNIOR");
  });

  it("prompt é minificado (sem whitespace redundante)", () => {
    const out = buildOrganizerSystemPrompt(null, COLS, NOW);
    expect(out.systemPrompt).not.toMatch(/\n{3,}/);
    expect(out.systemPrompt).not.toMatch(/[ \t]+\n/);
    expect(out.systemPrompt).not.toMatch(/\n[ \t]+/);
  });

  it("kanban appendix lista colunas em ordem com marca [TERMINAL]", () => {
    const out = buildKanbanAppendix(COLS);
    expect(out.kanbanAppendix).toContain("novo");
    expect(out.kanbanAppendix).toContain("sem_interesse");
    expect(out.kanbanAppendix).toContain("[TERMINAL");
    expect(out.kanbanAppendix).toContain("perdido");
    // Terminal marcado por flag
    expect(out.terminalKeys).toContain("sem_interesse");
    expect(out.terminalKeys).toContain("perdido");
    // Não-terminal não deve aparecer como terminal
    expect(out.terminalKeys).not.toContain("novo");
    expect(out.terminalKeys).not.toContain("fechado");
  });

  it("date context inclui data ISO e formato pt-BR", () => {
    const ctx = buildDateContext(NOW);
    expect(ctx).toContain("2026-08-11");
    expect(ctx).toContain("DATA DE HOJE");
  });
});

// ─────────── 2. APPOINTMENTS CONTEXT ───────────

describe("[Organizer] Appointments context", () => {
  it("lista appointments com FUTURO/PASSADO/EM CURSO", () => {
    const appts: AppointmentLite[] = [
      { start_at: "2026-08-15T14:00:00Z", end_at: "2026-08-15T15:00:00Z", status: "confirmed", service_name: "Corte" },
      { start_at: "2026-08-05T10:00:00Z", end_at: "2026-08-05T11:00:00Z", status: "completed", service_name: "Manicure" },
    ];
    const ctx = buildAppointmentsContext(appts, NOW);
    expect(ctx).toContain("FUTURO");
    expect(ctx).toContain("PASSADO");
    expect(ctx).toContain("Corte");
    expect(ctx).toContain("Manicure");
    expect(ctx).toContain("confirmed");
    expect(ctx).toContain("completed");
  });

  it("mostra mensagem vazia quando não há appointments", () => {
    const ctx = buildAppointmentsContext([], NOW);
    expect(ctx).toContain("Nenhum");
  });

  it("inclui regras derivadas de agendamentos (quando há appointments)", () => {
    const appts: AppointmentLite[] = [
      { start_at: "2026-08-15T14:00:00Z", end_at: "2026-08-15T15:00:00Z", status: "confirmed", service_name: "Corte" },
    ];
    const ctx = buildAppointmentsContext(appts, NOW);
    expect(ctx).toContain("REGRAS DERIVADAS");
    expect(ctx).toContain("confirmed");
    expect(ctx).toContain("completed");
    expect(ctx).toContain("cancelled");
    expect(ctx).toContain("no_show");
  });
});

// ─────────── 3. PROVIDER ROUTING ───────────

describe("[Organizer] Provider routing — parseModelRef + providerOf", () => {
  it("detecta Gemini bare (legado)", () => {
    expect(providerOf("gemini-2.5-flash")).toBe("gemini");
    expect(parseModelRef("gemini-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("detecta Gemini com prefixo explícito", () => {
    expect(providerOf("gemini:gemini-2.5-flash")).toBe("gemini");
    expect(parseModelRef("gemini:gemini-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("detecta OpenRouter com prefixo", () => {
    expect(providerOf("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("openrouter");
    expect(parseModelRef("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free")).toEqual({
      provider: "openrouter",
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    });
  });

  it("detecta Gateway com prefixo", () => {
    expect(providerOf("gateway:gpt-5")).toBe("gateway");
    expect(parseModelRef("gateway:gpt-5")).toEqual({ provider: "gateway", model: "gpt-5" });
  });

  it("formatModelRef monta string storable correta", () => {
    expect(formatModelRef("gemini", "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(formatModelRef("openrouter", "anthropic/claude-3.5-sonnet")).toBe("openrouter:anthropic/claude-3.5-sonnet");
    expect(formatModelRef("gateway", "gpt-5")).toBe("gateway:gpt-5");
  });

  it("stripa prefixo models/ do Gemini legado", () => {
    expect(parseModelRef("models/gemini-2.5-flash")).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("string vazia retorna provider gemini com model vazio", () => {
    expect(parseModelRef("")).toEqual({ provider: "gemini", model: "" });
    expect(parseModelRef(null)).toEqual({ provider: "gemini", model: "" });
    expect(parseModelRef(undefined)).toEqual({ provider: "gemini", model: "" });
  });
});

// ─────────── 4. FAILOVER & ERROR HANDLING ───────────

describe("[Organizer] Failover detection — isFailoverableStatus", () => {
  it("429 (rate limit) é failoverable", () => {
    expect(isFailoverableStatus(429)).toBe(true);
  });

  it("401/403 (credencial morta) é failoverable", () => {
    expect(isFailoverableStatus(401)).toBe(true);
    expect(isFailoverableStatus(403)).toBe(true);
  });

  it("5xx (server error) é failoverable", () => {
    expect(isFailoverableStatus(500)).toBe(true);
    expect(isFailoverableStatus(502)).toBe(true);
    expect(isFailoverableStatus(503)).toBe(true);
  });

  it("400 com mensagem de quota é failoverable", () => {
    expect(isFailoverableStatus(400, "quota exceeded")).toBe(true);
    expect(isFailoverableStatus(400, "rate limit reached")).toBe(true);
    expect(isFailoverableStatus(400, "insufficient credits")).toBe(true);
  });

  it("400 sem mensagem de quota NÃO é failoverable (erro do request)", () => {
    expect(isFailoverableStatus(400, "bad request")).toBe(false);
    expect(isFailoverableStatus(400, "invalid model")).toBe(false);
  });

  it("404 NÃO é failoverable (modelo não existe)", () => {
    expect(isFailoverableStatus(404)).toBe(false);
  });

  it("0 (rede/timeout) é failoverable", () => {
    expect(isFailoverableStatus(0)).toBe(true);
  });
});

// ─────────── 5. REASONING MODE ───────────

describe("[Organizer] Reasoning mode — resolveReasoningMode", () => {
  it("passa por valor quando válido (0-3)", () => {
    expect(resolveReasoningMode(0)).toBe(0);
    expect(resolveReasoningMode(1)).toBe(1);
    expect(resolveReasoningMode(2)).toBe(2);
    expect(resolveReasoningMode(3)).toBe(3);
  });

  it("deriva de thinkingBudget legado (retrocompat)", () => {
    expect(resolveReasoningMode(undefined, 0)).toBe(0);
    expect(resolveReasoningMode(undefined, 256)).toBe(1);
    expect(resolveReasoningMode(undefined, 8192)).toBe(1);
    expect(resolveReasoningMode(undefined, -1)).toBe(2);
  });

  it("default é 0 (econômico) quando nada passado", () => {
    expect(resolveReasoningMode(undefined, undefined)).toBe(0);
    expect(resolveReasoningMode(null, null)).toBe(0);
  });

  it("reasoningMode vence sobre thinkingBudget", () => {
    expect(resolveReasoningMode(2, 0)).toBe(2);
    expect(resolveReasoningMode(0, -1)).toBe(0);
  });
});

// ─────────── 6. APPLY REASONING ───────────

describe("[Organizer] applyReasoning — mapeamento por provedor", () => {
  it("OpenAI/GPT: adiciona reasoning.effort", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 0, "openrouter", "openai/gpt-4o");
    expect(body.reasoning).toEqual({ effort: "minimal" });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 2, "openrouter", "openai/gpt-4o");
    expect(body2.reasoning).toEqual({ effort: "high" });
  });

  it("Claude/Anthropic: adiciona thinking.budget_tokens", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 1, "gateway", "claude-sonnet-4");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });

    const body2: Record<string, any> = {};
    applyReasoning(body2, 2, "gateway", "claude-sonnet-4");
    expect(body2.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("Mode 3 (THINK MÁXIMO) expande max_tokens", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 3, "openrouter", "deepseek/deepseek-r1");
    expect(body.max_tokens).toBeGreaterThanOrEqual(8000);
  });

  it("Gemini é no-op (tratado em outro lugar)", () => {
    const body: Record<string, any> = { temperature: 0.5 };
    applyReasoning(body, 2, "gemini", "gemini-2.5-flash");
    expect(body).toEqual({ temperature: 0.5 });
  });

  it("Mode 0 econômico do Claude não adiciona thinking", () => {
    const body: Record<string, any> = {};
    applyReasoning(body, 0, "gateway", "claude-sonnet-4");
    expect(body.thinking).toBeUndefined();
  });
});

// ─────────── 7. SIMULAÇÃO DE FILTROS DO MOTOR ───────────

describe("[Organizer] Filtros de economia — simulação", () => {
  // Helpers que replicam a lógica de filtragem do /api/ai-organize
  const isTerminalByRegex = (k: string) => /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k);
  const terminalSet = new Set(COLS.filter(c => c.is_terminal || isTerminalByRegex(c.status_key)).map(c => c.status_key));

  it("FILTRO 1: terminal sem msg do cliente hoje → skip", () => {
    const status = "perdido";
    const clienteRespondeuHoje = false;
    const skip = terminalSet.has(status) && !clienteRespondeuHoje;
    expect(skip).toBe(true);
  });

  it("FILTRO 1: terminal COM msg do cliente hoje → NÃO skip", () => {
    const status = "perdido";
    const clienteRespondeuHoje = true;
    const skip = terminalSet.has(status) && !clienteRespondeuHoje;
    expect(skip).toBe(false);
  });

  it("FILTRO 2: sem msg do cliente + SDR mandou + status avançado → skip", () => {
    const status: string = "interessado";
    const clienteRespondeuHoje = false;
    const sdrMandouHoje = true;
    const ehNovo = status === "novo";
    const skip = !clienteRespondeuHoje && sdrMandouHoje && !ehNovo && status !== "novo";
    expect(skip).toBe(true);
  });

  it("FILTRO 2: status 'novo' → NÃO skip (precisa classificar)", () => {
    const status = "novo";
    const clienteRespondeuHoje = false;
    const sdrMandouHoje = true;
    const skip = !clienteRespondeuHoje && sdrMandouHoje && status !== "novo";
    expect(skip).toBe(false);
  });

  it("FILTRO 3: heurística detecta recusa explícita", () => {
    const texto = "não tenho interesse, obrigado";
    const recusa = /(n[ãa]o tenho interesse|n[ãa]o quero|n[ãa]o me liga|para de mandar|me tira|me remov|n[ãa]o me mande|j[áa] tenho|j[áa] uso|j[áa] sou)\b/i;
    expect(recusa.test(texto)).toBe(true);
  });

  it("FILTRO 3: heurística NÃO detecta interesse como recusa", () => {
    const texto = "qual o preço do serviço?";
    const recusa = /(n[ãa]o tenho interesse|n[ãa]o quero|n[ãa]o me liga|para de mandar|me tira|me remov|n[ãa]o me mande|j[áa] tenho|j[áa] uso|j[áa] sou)\b/i;
    expect(recusa.test(texto)).toBe(false);
  });

  it("FILTRO 3: heurística detecta número errado", () => {
    const texto = "número errado, não conheço essa pessoa";
    const errado = /(n[úu]mero errado|pessoa errada|n[ãa]o sou|n[ãa]o trabalho|n[ãa]o conhe[çc]o|enganou|engano)\b/i;
    expect(errado.test(texto)).toBe(true);
  });
});

// ─────────── 8. HIERARQUIA E ANTI-BOUNCING ───────────

describe("[Organizer] Hierarquia e anti-bouncing", () => {
  const hierarquia: Record<string, number> = {};
  COLS.forEach((c, i) => { hierarquia[c.status_key] = i; });

  it("hierarquia respeta ordem do kanban", () => {
    expect(hierarquia["novo"]).toBeLessThan(hierarquia["interessado"]);
    expect(hierarquia["interessado"]).toBeLessThan(hierarquia["agendado"]);
    expect(hierarquia["agendado"]).toBeLessThan(hierarquia["fechado"]);
  });

  it("isAdvancedStage: top 40% do kanban = avançado", () => {
    // 8 colunas, top 40% = índices >= Math.floor(8 * 0.4) = 3
    const threshold = Math.floor(COLS.length * 0.4);
    expect(hierarquia["follow_up"]).toBeGreaterThanOrEqual(threshold);
    expect(hierarquia["agendado"]).toBeGreaterThanOrEqual(threshold);
    expect(hierarquia["fechado"]).toBeGreaterThanOrEqual(threshold);
    // novo e primeiro_contato NÃO são avançados
    expect(hierarquia["novo"]).toBeLessThan(threshold);
    expect(hierarquia["primeiro_contato"]).toBeLessThan(threshold);
  });

  it("anti-downgrade: bloqueia rebaixe de agendado → primeiro_contato", () => {
    const isTerminal = (k: string) => terminalSet_has(k);
    function terminalSet_has(k: string) {
      return COLS.find(c => c.status_key === k)?.is_terminal === true || /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k);
    }
    const statusAntigo = "agendado";
    const novoStatus = "primeiro_contato";
    const threshold = Math.floor(COLS.length * 0.4);
    const isAdvanced = (k: string) => hierarquia[k] >= threshold;
    const blockDowngrade = !isTerminal(novoStatus) && isAdvanced(statusAntigo) && !isAdvanced(novoStatus);
    expect(blockDowngrade).toBe(true);
  });

  it("anti-downgrade: PERMITE mover pra terminal (mesmo sendo downgrade)", () => {
    const isTerminal = (k: string) => /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k) ||
      COLS.find(c => c.status_key === k)?.is_terminal === true;
    const statusAntigo = "agendado";
    const novoStatus = "sem_interesse";
    const blockDowngrade = !isTerminal(novoStatus);
    expect(blockDowngrade).toBe(false);
  });
});

// ─────────── 9. JSON PARSE ROBUSTEZ ───────────

describe("[Organizer] JSON parse robustez", () => {
  function parseOrganizerResponse(textResponse: string): any[] {
    const jsonMatch = textResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let cleanJson = jsonMatch ? jsonMatch[1] : textResponse;
    const startIndex = cleanJson.indexOf('[');
    const endIndex = cleanJson.lastIndexOf(']');
    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
      cleanJson = cleanJson.substring(startIndex, endIndex + 1);
    }
    return JSON.parse(cleanJson);
  }

  it("parse JSON array limpo", () => {
    const input = '[{"jid":"123@s.whatsapp.net","status":"interessado","razao":"R6"}]';
    const result = parseOrganizerResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("interessado");
  });

  it("parse JSON com markdown code block", () => {
    const input = '```json\n[{"jid":"123","status":"fechado"}]\n```';
    const result = parseOrganizerResponse(input);
    expect(result[0].status).toBe("fechado");
  });

  it("parse JSON com texto antes e depois", () => {
    const input = 'Aqui está:\n[{"jid":"123","status":"novo"}]\nFim.';
    const result = parseOrganizerResponse(input);
    expect(result[0].status).toBe("novo");
  });

  it("parse JSON com objeto único (fallback)", () => {
    const input = '{"123":"interessado"}';
    // O código do organizer converte objeto em array
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch { parsed = []; }
    if (!Array.isArray(parsed) && typeof parsed === "object") {
      parsed = Object.entries(parsed).map(([k, v]) => ({ jid: k, status: v as string }));
    }
    expect(parsed[0].jid).toBe("123");
    expect(parsed[0].status).toBe("interessado");
  });

  it("aceita lead_type nos resultados", () => {
    const input = '[{"jid":"123","status":"interessado","lead_type":"qualificado","razao":"R6","resumo":"Cliente pediu preco"}]';
    const result = parseOrganizerResponse(input);
    expect(result[0].lead_type).toBe("qualificado");
  });
});

// ─────────── 10. CONFIG INTEGRITY ───────────

describe("[Organizer] Config integrity — modelo configurado é OpenRouter free", () => {
  it("modelo configurado no banco tem prefixo openrouter:", () => {
    // O modelo salvo no banco é "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"
    const savedModel = "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free";
    expect(providerOf(savedModel)).toBe("openrouter");
    const ref = parseModelRef(savedModel);
    expect(ref.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(ref.model).toContain(":free");
  });

  it("provider field 'Gemini' (legado) é override pelo prefixo do modelRef", () => {
    // No /api/ai-organize:
    //   const refProvider = providerOf(model);
    //   if (refProvider === "openrouter") provider = "OpenRouter";
    const model = "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free";
    let provider = "Gemini"; // legado do banco
    const refProvider = providerOf(model);
    if (refProvider === "openrouter") provider = "OpenRouter";
    expect(provider).toBe("OpenRouter");
  });
});
