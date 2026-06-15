/**
 * Prompt do Organizador IA — montagem centralizada.
 *
 * Compartilhado entre /api/ai-organize (executa) e
 * /api/organizer/effective-prompt (mostra ao usuário).
 *
 * Retorna 4 pedaços + o systemPrompt final concatenado, pra UI poder
 * mostrar separadamente o que vem do cliente vs. o que é regra fixa.
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
     - Status atual = agendado + DATA da reunião JÁ PASSOU (compare com DATA DE HOJE no contexto) + cliente agradece/avalia/conta como foi → ATENDIMENTO OCORREU. Sobe pro próximo estágio do kanban DEPOIS de agendado (geralmente "fechado"/"atendido"/"comprou"). NÃO mantém em "agendado" porque já passou.

R16. ESTÁGIO AVANÇADO + dúvida operacional única:
     - Cliente em interessado/follow-up/agendado/fechado + pergunta operacional curta ("qual horário", "tem estacionamento", "atende sábado") sem sinal de compra/desistência.
     - SEMPRE mantém status. Anota a pergunta em "resumo".

R17. PÓS-ATENDIMENTO inteligente (qualquer nicho):
     - Sinais textuais de que o serviço/produto JÁ FOI ENTREGUE: "amei", "ficou ótimo", "adorei", "foi excelente", "obrigada pelo atendimento", "valeu", "show", "recomendo", "voltarei", "perfeito o serviço", "ficou linda", agradecimento + elogio + ausência de pergunta sobre marcar de novo.
     - Combinado com data agendada já no passado OU status atual = agendado.
     - Decisão: mover pro estágio TERMINAL POSITIVO do kanban deste cliente (ex: "fechado", "atendido", "concluido"). Se não houver tal estágio, mantém "agendado" e marca lead_type="cliente_ativo".
     - Se o cliente JÁ PERGUNTOU sobre marcar de novo / outro serviço → também é sinal de pós-atendimento. lead_type="recorrente".

## HIERARQUIA (nunca rebaixe, exceto pra estados terminais):

- Use a ORDEM DAS COLUNAS DO KANBAN (lista no apêndice). Index menor = início do funil; maior = mais avançado.
- Terminais podem ser aplicados de qualquer estágio com evidência CLARA.
- Se nada novo aconteceu hoje, REPITA o status atual.

## COMO ESCREVER "razao" E "resumo":

"razao" (≤ 160 chars): cite a REGRA acionada (R1-R17) e a evidência curta.
  - "R15: cliente em agendado fez pergunta off-topic ('aceita pix?'). Mantido."
  - "R17: cliente agradeceu pós-atendimento ('amei o resultado'). Movido pra atendido."

"resumo" (1-3 frases, ≤ 400 chars): descreva O QUE aconteceu HOJE + contexto + próximo passo.

## ARMADILHAS — NÃO CAIA:

- "Ok, obrigado" → NÃO é fechamento, é educação.
- "Vou ver e te aviso" → "follow-up", NÃO "interessado".
- Cliente em agendado fazendo pergunta off-topic → JAMAIS volta pra interessado/primeiro_contato.
- Lead em estágio avançado fazendo dúvida operacional única → mantém status.

## FORMATO DE RESPOSTA:

JSON array. Cada item:
- "jid": string (copie exato do CHAT ID)
- "status": status_key EXATO do kanban deste cliente (ver apêndice)
- "lead_type": "novo" | "cliente_ativo" | "recorrente" | "unica_duvida" | "qualificado" | "frio"
- "razao": ≤ 160 chars. REGRA + evidência.
- "resumo": 1-3 frases (≤ 400 chars).

Nada além do JSON. Sem markdown, sem explicação.
`.trim();

export type KanbanColLite = { status_key: string; label: string; order_index: number };

export function buildKanbanAppendix(cols: KanbanColLite[]): { kanbanAppendix: string; terminalKeys: string[] } {
  if (cols.length === 0) {
    return { kanbanAppendix: "", terminalKeys: [] };
  }
  const isTerminalKey = (k: string) => /sem_interesse|descartado|perdido|cancelado|recusou/i.test(k);
  const terminalKeys = cols.map(c => c.status_key).filter(isTerminalKey);

  const appendix = `

## ESTÁGIOS DISPONÍVEIS NESTE KANBAN (use SOMENTE estes status_key — index 0 é o início do funil):
${cols.map((c, i) => `  ${i}. status_key="${c.status_key}"  →  label exibido: "${c.label}"`).join("\n")}

REGRAS ESPECÍFICAS PARA ESTE KANBAN:
- Use o "status_key" EXATO (minúsculas com underscore) no campo "status". NÃO use o "label".
- Hierarquia = ordem acima. NUNCA rebaixe exceto pra terminais.
- Terminais detectados: ${terminalKeys.length > 0 ? terminalKeys.join(", ") : "(nenhum — não há terminal negativo neste kanban)"}.
- Estágios que casam com "agendado/agendamento/reuniao/marcado/reservado" → ponto alto do funil. R15 vale: NÃO rebaixar.
- Estágios que casam com "fechado/comprou/contratado/atendido/concluido/realizado" → conclusão positiva. R11 + R17 valem.
`;
  return { kanbanAppendix: appendix, terminalKeys };
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
 *
 * Isso TRANSFORMA o raciocínio do organizer de "inferir da conversa" pra
 * "saber de fonte estruturada". R15/R17 passam a ter ground truth: se a IA
 * vê que existe appointment confirmed no futuro, NÃO rebaixa pra interessado.
 * Se vê appointment completed/passado, sobe pra terminal positivo.
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
  appointments: AppointmentLite[] = []
) {
  const defaultBasePrompt = DEFAULT_ORGANIZER_BASE_PROMPT;
  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : defaultBasePrompt;
  const { kanbanAppendix, terminalKeys } = buildKanbanAppendix(cols);
  const dateContext = buildDateContext(now);
  const appointmentsContext = buildAppointmentsContext(appointments, now);
  const systemPrompt = basePrompt + kanbanAppendix + dateContext + appointmentsContext;
  return { systemPrompt, defaultBasePrompt, kanbanAppendix, dateContext, appointmentsContext, terminalKeys };
}
