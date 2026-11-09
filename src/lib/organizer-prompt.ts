/**
 * Prompt do Organizador IA — montagem centralizada e auto-adaptativa.
 *
 * Compartilhado entre /api/ai-organize (executa) e
 * /api/organizer/effective-prompt (mostra ao usuário).
 *
 * Retorna pedaços estruturados + o systemPrompt final concatenado e minificado.
 */

export const DEFAULT_ORGANIZER_BASE_PROMPT = `
Você é um classificador SÊNIOR de contatos comerciais para QUALQUER NICHO de negócio
(B2B, B2C, salão, manicure, imobiliária, advocacia, e-commerce, médico, oficina, escola,
restaurante, prestador de serviço, freelance, qualquer um). Trabalha em cima do kanban
configurado pelo cliente — adapta o vocabulário e a hierarquia do funil ao kanban dele.
Vai receber conversas de HOJE, agrupadas por contato. Cada bloco vem com CONTEXTO HISTÓRICO rico:

- STATUS ATUAL NO CRM (do kanban deste cliente — pode ser qualquer estrutura)
- ORIGEM DO CONTATO (disparo em massa / cliente iniciou / contato manual / desconhecida)
- PRIMEIRO CONTATO REGISTRADO (data e hora)
- MENSAGENS DO AGENTE/OPERADOR ANTES DE HOJE / RESPOSTAS DO CLIENTE ANTES DE HOJE
- FLAGS marcados com ⚑

Sua missão: decidir o estágio REAL com base no conteúdo de HOJE + HISTÓRICO + estágio atual + DATA DE HOJE. SEM alucinar, SEM achismo, SEM mover só porque "melhorou o tom".

## COMO LER A CONVERSA SEM ERRO:
- Mensagens marcadas com "SDR:" foram enviadas pela NOSSA empresa (Agente IA ou vendedor humano).
- Mensagens marcadas com "CLIENTE:" foram enviadas pelo LEAD.
- JAMAIS confunda uma oferta ou pergunta feita pelo "SDR:" com algo dito pelo "CLIENTE:".

## REGRAS DE DECISÃO (ordem de avaliação — pare na primeira que casar):

R1. CLIENTE recusou/xingou/pediu remoção/"não tenho interesse"/"pare de enviar" → status TERMINAL do kanban (sem_interesse/perdido/descartado/recusou).
R2. CLIENTE disse que não é o negócio alvo / é pessoa física / número errado → status TERMINAL (descartado/perdido).
R3. CONFIRMAÇÃO clara e mútua de compra/pagamento/contrato assinado HOJE → status mais avançado do kanban (fechado/comprou/contratado).
R4. Reunião/atendimento com DATA+HORA explícitas confirmada pelos dois lados → status "agendado" (ou equivalente do kanban).
R5. Retorno futuro concreto foi COMBINADO (dia/período acordado) → "follow-up" (ou equivalente).
R6. CLIENTE fez pergunta objetiva sobre preço/condição/funcionalidade/prazo/disponibilidade → "interessado" (ou equivalente).
R7. CLIENTE respondeu algo curto/neutro ("oi", "pode falar", "quem é?") sem pedir preço → "primeiro_contato" (ou equivalente).
R8. Agente/operador mandou HOJE prospecção/follow-up e cliente NÃO respondeu:
    - Se ⚑ ESTA É A PRIMEIRA INTERAÇÃO → "primeiro_contato".
    - Se ORIGEM = disparo em massa E cliente ainda não respondeu em nenhum dia → "primeiro_contato".
    - Se status atual já é mais avançado → MANTENHA.
R9. CLIENTE respondeu mas HOJE não há mensagem do agente/operador (⚑ CLIENTE RESPONDEU ESPONTANEAMENTE) → reavalie por R1-R7. Cliente retomando sozinho é sinal forte.

R10. ⚑ LEAD AUTO-PROMOVIDO PARA FOLLOW-UP (status=follow-up, origem=disparo, sem resposta):
     - Se HOJE respondeu algo interessante → reavalie por R1-R7.
     - Sem resposta → MANTENHA "follow-up", anote "auto-promovido após X dias".
     - NUNCA rebaixe para "primeiro_contato".

R11. CLIENTE RECORRENTE / JÁ COMPROU (status terminal positivo, ou lead_type prévio = "cliente_ativo"/"recorrente"):
     - JAMAIS rebaixe. Mantenha o status atual.
     - SÓ mude pra terminal negativo se ELE EXPLICITAMENTE pedir cancelamento.
     - Nova venda separada → anote em "razao", mantém status.

R12. DÚVIDA ÚNICA vs INTERESSE REAL:
     - Pergunta CURTA pontual + sem sinal de compra prévio → lead_type="unica_duvida". Mantenha status.
     - Pergunta sobre preço/condição/proposta + contexto de compra → lead_type="qualificado" + "interessado".

R13. ANTI-BOUNCING (⚑ marcador):
     - Tocado pela IA nas últimas 24h + quer mudar de novo → exige EVIDÊNCIA TEXTUAL FORTE. Em dúvida, mantenha.

R14. SUSPEITA DE FALSO POSITIVO:
     - "Vou pensar" / "depois te respondo" → "follow-up", NÃO "interessado".
     - "Vou ver com sócio" → "follow-up".
     - Cliente perguntou e sumiu → mantém status atual.

R15. JÁ AGENDADO — off-topic / confirmação NÃO rebaixa (CRÍTICO):
     - Status atual = agendado/reservado/marcado + cliente manda dúvida sobre OUTRO assunto ("aceita pix?", "pode levar acompanhante?", "que horário mesmo?", "tô com dor de cabeça", "que roupa usar") → MANTÉM status.
     - Status atual = agendado + cliente confirma ("tô indo", "confirmado", "tá certo", "obrigada") → MANTÉM status.
     - Status atual = agendado + cliente pede REMARCAR → MANTÉM ou move pra "follow-up" se existir. NUNCA volta pra "interessado"/"primeiro_contato".
     - Status atual = agendado + cliente CANCELA explicitamente ("não vou mais", "desisti", "cancela") → status terminal negativo.
     - Status atual = agendado + DATA da reunião JÁ PASSOU (compare com DATA DE HOJE no contexto) + cliente agradece/avalia/conta como foi → suba pra status TERMINAL POSITIVO (fechado/atendido/concluído).

R16. REAVALIAÇÃO DE TERMINAL (EXCEÇÃO):
     - Se lead estava em status TERMINAL (descartado/perdido/sem_interesse), mas HOJE ele mandou mensagem com pergunta clara de interesse/compra → RETIRE do terminal e mova pra "interessado" ou status adequado.
     - Terminal NÃO é prisão eterna se o próprio cliente voltou a procurar.

R17. PÓS-ATENDIMENTO / AGENDAMENTO CONCLUÍDO NO PASSADO:
     - Se o lead já passou pelo atendimento (data da reunião < DATA DE HOJE) e a conversa mostra que foi atendido com sucesso (ex: agradeceu, elogiou, mandou comprovante) → SUBA para status TERMINAL POSITIVO do kanban ("fechado" / "atendido" / "concluído").
     - Se faltou/não apareceu → mova pra "follow-up" se existir no kanban, ou mantenha se não houver.

## COMO ESCREVER "razao" E "resumo":
- "razao" (≤ 160 chars): Comece citando a regra aplicada (ex: "R4: agendou corte quinta 15h"). Seja telegráfico, direto ao ponto.
- "resumo" (1-2 frases, ≤ 350 chars): Visão executiva pro operador humano ler rápido. Ex: "Cliente pediu orçamento de mechas, aceitou quinta 15h com Ana. Sem pendências."

## FORMATO DE RESPOSTA:
Responda APENAS um JSON array válido. Cada item:
- "jid": string (exatamente o CHAT ID recebido)
- "status": string (status_key EXATO do kanban deste cliente — ver apêndice abaixo)
- "lead_type": "novo" | "cliente_ativo" | "recorrente" | "unica_duvida" | "qualificado" | "frio"
- "razao": string curta (≤ 160 chars, citando R1-R17)
- "resumo": string executiva (1-2 frases, ≤ 350 chars)
`.trim();

export type KanbanColLite = {
  status_key: string;
  label: string;
  order_index?: number;
  is_terminal?: boolean;
};

export type AgentContextLite = {
  name?: string | null;
  main_prompt?: string | null;
  role?: string | null;
};

const isNegativeTerminalKey = (k: string) => /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k);

export function isTerminalColumn(col: Pick<KanbanColLite, "status_key" | "label" | "is_terminal">): boolean {
  if (col.is_terminal) return true;
  const combined = `${col.status_key || ""} ${col.label || ""}`.toLowerCase();
  return /sem_interesse|descartado|perdido|cancelado|recusou|fechado|ganho|contratado|comprou/i.test(combined);
}

export function inferColumnSemanticGuide(col: { status_key?: string; label?: string; order_index?: number }, totalCols: number = 10): string {
  const combined = `${col.status_key || ""} ${col.label || ""}`.toLowerCase();
  if (/novo|lead_novo|inbox|entrada/.test(combined)) {
    return "Leads recém-extraídos/cadastrados sem nenhuma mensagem enviada ainda.";
  }
  if (/primeiro_contato|abordado|disparo|1_contato|contato_inicial|1º contato/.test(combined)) {
    return "Abordagem inicial enviada pelo SDR/IA, mas o cliente ainda não respondeu (ou só enviou saudação automática única).";
  }
  if (/qualifica|triagem|atendimento|conversando|diagnostico|engajado|respondeu/.test(combined)) {
    return "Cliente humano respondeu e está em conversa/diagnóstico com a IA.";
  }
  if (/previa_solicitada|previa_pedida|aceitou_previa|gerar_previa|orcamento_solicitado/.test(combined)) {
    return "Cliente ACEITOU receber a prévia gratuita, demonstração ou orçamento e aguarda o envio do link.";
  }
  if (/em_negociacao|negociacao|previa_enviada|previa_pronta|proposta|orcamento_enviado/.test(combined)) {
    return "Link da prévia/apresentação já foi enviado na conversa OU proposta de valores já foi apresentada.";
  }
  if (/interessado|qualificado|quente|oportunidade/.test(combined)) {
    return "Cliente demonstrou interesse concreto na solução, pediu detalhes/preço ou avançou positivamente.";
  }
  if (/agendad|reuniao|call|consulta|visita|marcado/.test(combined)) {
    return "Reunião, call ou atendimento agendado com horário combinado.";
  }
  if (/follow|nutrir|retornar|aguardando|depois|frio/.test(combined)) {
    return "Cliente pediu para conversar mais pra frente ou ficou de analisar/retornar depois.";
  }
  if (/fechad|ganho|vendid|contratad|comprou|concluid/.test(combined)) {
    return "[TERMINAL POSITIVO] Venda concluída, pagamento/contrato fechado ou serviço realizado.";
  }
  if (/sem_interesse|perdid|recus|nao_quis|cancelad/.test(combined)) {
    return "[TERMINAL NEGATIVO] Cliente recusou a oferta claramente ou declarou não ter interesse.";
  }
  if (/descartad|invalid|errado|robo|ura/.test(combined)) {
    return "[TERMINAL NEGATIVO] Número inválido/errado ou URA/robô automático em loop.";
  }
  return `Estágio do funil "${col.label || col.status_key}".`;
}

export function buildKanbanAppendix(cols: KanbanColLite[]): { kanbanAppendix: string; terminalKeys: string[] } {
  if (cols.length === 0) {
    return { kanbanAppendix: "", terminalKeys: [] };
  }
  const terminalKeys = cols.filter(c => c.is_terminal || isNegativeTerminalKey(c.status_key)).map(c => c.status_key);

  const appendix = `

## ESTÁGIOS DISPONÍVEIS NESTE KANBAN (use SOMENTE estes status_key — index 0 é o início do funil):
${cols.map((c, i) => `  ${i}. status_key="${c.status_key}"  →  label exibido: "${c.label}"${(c.is_terminal || isNegativeTerminalKey(c.status_key)) ? "  [TERMINAL — sem volta]" : ""}`).join("\n")}

REGRAS ESPECÍFICAS PARA ESTE KANBAN:
- Use o "status_key" EXATO (minúsculas com underscore) no campo "status". NÃO use o "label".
- Hierarquia = ordem acima. NUNCA rebaixe exceto pra terminais.
- Colunas marcadas [TERMINAL] são finais — lead não volta delas. Use quando cliente recusar/descartar.
- Estágios no TOP 40% do kanban (índices altos) = avançados. NÃO rebaixa por mensagem off-topic.
- Estágios que casam com "agendado/agendamento/reuniao/marcado/reservado" → ponto alto do funil. R15 vale: NÃO rebaixar.
- Estágios que casam com "fechado/comprou/contratado/atendido/concluido/realizado" → conclusão positiva. R11 + R17 valem.
`;
  return { kanbanAppendix: appendix, terminalKeys };
}

export function buildAgentContextAppendix(agent?: AgentContextLite | null): string {
  if (!agent || (!agent.main_prompt && !agent.name)) return "";
  const rawPrompt = (agent.main_prompt || "").trim();
  const compactExcerpt = rawPrompt
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("---"))
    .slice(0, 14)
    .join(" | ")
    .slice(0, 750);

  if (!compactExcerpt && !agent.name) return "";
  return `\n\n## CONTEXTO DO AGENTE DE IA DESTA CONTA:
Agente: ${agent.name || "Agente Principal"}${agent.role ? ` (${agent.role})` : ""}
Resumo da operação: ${compactExcerpt}\n`;
}

export function buildDateContext(now: Date = new Date()): string {
  const fmt = now.toLocaleDateString("pt-BR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const iso = now.toISOString().slice(0, 10);
  return `\n\n## CONTEXTO TEMPORAL\nDATA DE HOJE: ${fmt} (${iso}).\nUse essa data pra raciocinar sobre R15/R17 (atendimento já passou ou não).\n`;
}

export type AppointmentLite = {
  start_at: string;
  end_at: string;
  status: string;
  title?: string;
  service_name?: string | null;
};

/**
 * Constrói bloco de contexto sobre agendamentos REAIS deste lead (vindos da
 * tabela appointments, sincronizada com Google Calendar).
 */
export function buildAppointmentsContext(
  appointments: AppointmentLite[],
  now: Date = new Date()
): string {
  if (!appointments || appointments.length === 0) {
    return `\n## AGENDAMENTOS ESTRUTURADOS DESTE LEAD (fonte: tabela appointments)\n(Nenhum agendamento registrado pra este lead.)\n`;
  }
  const nowMs = now.getTime();
  const lines: string[] = [];
  for (const a of appointments) {
    const startMs = new Date(a.start_at).getTime();
    const endMs = new Date(a.end_at).getTime();
    const tempo = startMs > nowMs ? "FUTURO" : (endMs < nowMs ? "PASSADO" : "EM CURSO");
    const data = new Date(a.start_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    const hora = new Date(a.start_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const servico = a.service_name || a.title || "(sem título)";
    lines.push(`  - ${data} ${hora} — "${servico}" — status=${a.status} — ${tempo}`);
  }
  return `\n## AGENDAMENTOS ESTRUTURADOS DESTE LEAD (fonte: tabela appointments — Google Calendar)
${lines.join("\n")}

REGRAS DERIVADAS DOS AGENDAMENTOS (têm prioridade sobre inferência da conversa):
- Se há agendamento status='confirmed' no FUTURO → MANTÉM lead em "agendado" (NUNCA rebaixe pra interessado/primeiro_contato).
- Se há agendamento status='completed' OU agendamento confirmed cujo end_at já passou + cliente agradeceu/elogiou → SUBA pra estágio TERMINAL POSITIVO do kanban (fechado/atendido/concluído).
- Se há agendamento status='cancelled' → respeite (não conta como agendado ativo).
- Se há agendamento status='no_show' (cliente não compareceu) → R14 vale: status atual mantém ou move pra follow-up se existir.
- Use estes dados em CONJUNTO com R15 (já agendado / data passou) e R17 (pós-atendimento).
`;
}

export function buildOrganizerSystemPrompt(
  customPrompt: string | null,
  cols: KanbanColLite[],
  now: Date = new Date(),
  appointments: AppointmentLite[] = [],
  agentContext?: AgentContextLite | null
) {
  const defaultBasePrompt = DEFAULT_ORGANIZER_BASE_PROMPT;
  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : defaultBasePrompt;
  const { kanbanAppendix, terminalKeys } = buildKanbanAppendix(cols);
  const agentAppendix = buildAgentContextAppendix(agentContext);
  const dateContext = buildDateContext(now);
  const appointmentsContext = buildAppointmentsContext(appointments, now);
  const systemPrompt = minifyPrompt(basePrompt + agentAppendix + kanbanAppendix + dateContext + appointmentsContext);
  return { systemPrompt, defaultBasePrompt, kanbanAppendix, dateContext, appointmentsContext, agentAppendix, terminalKeys };
}

function minifyPrompt(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extrai e faz parse seguro de JSON retornado por qualquer LLM (Gemini, OpenCode/Gateway,
 * OpenRouter, NVIDIA NIM, Claude, DeepSeek, Llama), tolerando:
 * - tags de raciocínio <think>...</think>
 * - cercas markdown ```json ... ```
 * - texto introdutório/conclusivo fora do JSON
 * - quebras de linha literais não escapadas dentro de strings JSON
 * - vírgulas finais sobrando antes de } ou ]
 */
export function extractJsonSafe<T = any>(raw: string): T {
  if (!raw || typeof raw !== "string") {
    throw new Error("Resposta vazia da IA");
  }

  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // continua para extração e reparo
  }

  const firstObj = cleaned.indexOf("{");
  const firstArr = cleaned.indexOf("[");
  let start = -1;
  let isArray = false;
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    isArray = false;
  } else if (firstArr !== -1) {
    start = firstArr;
    isArray = true;
  }

  if (start !== -1) {
    const end = isArray ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
    if (end > start) {
      cleaned = cleaned.slice(start, end + 1);
    } else {
      cleaned = cleaned.slice(start);
    }
  }

  const repaired = repairJsonStringLiterals(cleaned).replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(repaired) as T;
}

function repairJsonStringLiterals(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
    }
    out += ch;
  }
  return out;
}
