/**
 * Presets oficiais do Método Mentor (Abordagem 2-Step Anti-Ban -> Sarah Fase 1 -> Entrega X1 Manual).
 */

export const MENTOR_2STEP_TEMPLATE =
  "{Oi|Olá}, tudo bem? Falo com {a equipe da|o pessoal da|o responsável pela} {{nome_empresa}}?";

export const MENTOR_2STEP_VARIANTS = [
  "{Oi|Olá}, tudo bem? Falo com {a equipe da|o pessoal da|o responsável pela} {{nome_empresa}}?",
  "{{saudacao}}! Tudo bem? Aí é da {{nome_empresa}}?",
  "Oi, {{saudacao_lower}}, tudo certo? É o WhatsApp da {{nome_empresa}}?",
];

export const MENTOR_VIDEO_PRAISE_TEMPLATE =
  "{{saudacao}}! Tudo bem? Vi vocês no Google com nota {{avaliacao}} ({{reviews}} avaliações), parabéns pelo trabalho da {{empresa_curta}}! Hoje os clientes chegam mais pelo WhatsApp ou Instagram?";

export const MENTOR_VIDEO_PRAISE_VARIANTS: readonly string[] = [
  "{{saudacao}}! Tudo bem? Vi vocês no Google com nota {{avaliacao}} ({{reviews}} avaliações), parabéns pelo trabalho da {{empresa_curta}}! Hoje os clientes chegam mais pelo WhatsApp ou Instagram?",
  "{Oi|Olá}, {{saudacao_lower}}! Gostei bastante da reputação de vocês no Google ({{avaliacao}} estrelas). Quando buscam a {{empresa_curta}} por lá não acham site próprio — hoje os clientes vêm mais pelo WhatsApp ou Instagram?",
  "{{saudacao}}! Vi a {{empresa_curta}} no Google com {{reviews}} avaliações muito boas. Hoje os atendimentos novos chegam direto no WhatsApp ou mais pelo Instagram?",
];

export interface PostPreviewFollowupPresetSpec {
  name: string;
  source_status: string;
  weekend_guard: "sunday_only";
  steps: Array<{ day_offset: number; template: string }>;
}

export const POST_PREVIEW_FOLLOWUP_PRESET: PostPreviewFollowupPresetSpec = {
  name: "Cadência Pós-Prévia (Método Vídeo)",
  source_status: "previa_enviada",
  weekend_guard: "sunday_only",
  steps: [
    {
      day_offset: 1,
      template:
        "{{saudacao}}, {{nome_empresa}}! Só confirmando se você conseguiu abrir o link da prévia certinho pelo celular.",
    },
    {
      day_offset: 3,
      template:
        "{{saudacao}}! O que achou do visual e dos botões direto pro WhatsApp da {{empresa_curta}}? Se quiser mudar alguma cor, foto ou texto, ajusto na hora.",
    },
    {
      day_offset: 6,
      template:
        "Oi {{nome_empresa}}, prometo não te incomodar mais. Vou deixar a prévia publicada no ar só até amanhã pra você avaliar com calma — se fizer sentido colocar no ar pra {{empresa_curta}}, me dá um toque por aqui.",
    },
  ],
};

export const SARAH_MENTOR_2STEP_PROMPT = `Você é a Sarah, consultora especialista da equipe de criação de sites profissionais para empresas e clínicas no Brasil.

FLUXO OBRIGATÓRIO — MÉTODO MENTOR (APENAS FASE 1 — PRÉVIA SEM COMPROMISSO):
Contexto: o disparo inicial apenas perguntou se falava com a empresa para confirmar o contato.

1. QUANDO O LEAD CONFIRMAR QUE É A EMPRESA ("sim", "pode falar", "é sim", "olá", "quem fala?"):
   - Elogie brevemente a presença no Google ({{empresa}} com nota {{nota}} e {{avaliacoes}} avaliações em {{cidade}}, ou a presença no Google se faltar algum dado).
   - Explique em 1 frase curta que quem pesquisa a empresa hoje no Google não encontra um site próprio.
   - Faça EXATAMENTE 1 pergunta curta: hoje os clientes/pacientes chegam mais pelo Instagram, Google ou WhatsApp?

2. QUANDO O LEAD RESPONDER COMO CHEGAM OS CLIENTES (Instagram, WhatsApp, indicação, Google):
   - Valide a resposta em 1 linha.
   - Mostre o valor prático: explique que no site próprio ficam todos os serviços/especialidades claros, dúvidas respondidas e um botão direto pro WhatsApp com mensagem pronta (o cliente já chega pronto pra agendar/comprar).
   - Oferte uma prévia personalizada gratuita e sem compromisso para ela avaliar sem custo nenhum: pergunte se você pode enviar essa prévia por aqui mesmo.

3. QUANDO O LEAD ACEITAR VER A PRÉVIA ("pode mandar", "sim", "quero ver", "manda"):
   - Agradeça com simpatia e avise que a equipe vai caprichar e enviar o link nessa conversa (prazo de até 2 dias úteis, se aplicável, ou em breve).
   - Se o lead tiver Instagram/fotos, peça apenas o @ do Instagram ou confirmação de uso das fotos do Google para deixar a prévia com a cara da empresa — OU finalize de forma limpa: "Combinado! Assim que a prévia ficar pronta, mando aqui nessa conversa."
   - NUNCA negocie preços, planos, prazos contratuais ou link de pagamento nesta fase (Fase 2 será assumida manualmente pelo especialista no X1).

4. SE RECUSAR OU FOR NÚMERO ERRADO:
   - Agradeça educadamente e encerre sem insistência.

REGRAS DE OURO:
- Mensagens curtas, naturais de WhatsApp (máximo 2-3 linhas por balão).
- Nunca envie links ou textos longos na primeira interação.
- Faça no máximo 1 pergunta por resposta.`;

export interface MentorKanbanColumnSpec {
  status_key: string;
  label: string;
  color: string;
  order_index: number;
  is_terminal?: boolean;
}

export const MENTOR_KANBAN_PRESET: MentorKanbanColumnSpec[] = [
  { status_key: "novo", label: "Lead Captado", color: "#64748b", order_index: 0 },
  { status_key: "contatado", label: "1ª Msg Enviada", color: "#3b82f6", order_index: 1 },
  { status_key: "em_conversa", label: "Respondeu / Conversando", color: "#8b5cf6", order_index: 2 },
  { status_key: "previa_aceita", label: "Prévia Aceita", color: "#f59e0b", order_index: 3 },
  { status_key: "previa_enviada", label: "Prévia Enviada", color: "#06b6d4", order_index: 4 },
  { status_key: "negociacao_x1", label: "Negociação X1", color: "#ec4899", order_index: 5 },
  { status_key: "fechado", label: "Fechado", color: "#10b981", order_index: 6, is_terminal: true },
  { status_key: "perdido", label: "Perdido / Recusa", color: "#ef4444", order_index: 7, is_terminal: true },
];
