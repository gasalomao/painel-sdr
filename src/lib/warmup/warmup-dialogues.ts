/**
 * Banco de diálogos nativos e conteúdos para maturação de chips no WhatsApp (pt-BR).
 * Conversas naturais, cotidianas e informais, simulando interações reais entre conhecidos.
 */

export interface DialogueScript {
  id: string;
  theme: string;
  turns: Array<{
    speaker: "A" | "B";
    text: string;
    reaction?: string;
    sendAudioInstead?: boolean;
    audioCaption?: string;
  }>;
}

export const WARMUP_THEMES = [
  { id: "dia_a_dia", label: "Dia a Dia & Rotina", icon: "Coffee" },
  { id: "futebol", label: "Futebol & Esportes", icon: "Trophy" },
  { id: "trabalho", label: "Trabalho & Projetos", icon: "Briefcase" },
  { id: "churrasco", label: "Churrasco & Fim de Semana", icon: "Flame" },
  { id: "tecnologia", label: "Tecnologia & Celulares", icon: "Cpu" },
  { id: "compras", label: "Compras & Dicas", icon: "ShoppingBag" },
] as const;

export const NATURAL_REACTIONS = ["👍", "❤️", "😂", "🔥", "👏", "👊", "🙌", "✨"];

export const STATUS_STORIES_QUOTES = [
  "Começando o dia com aquele cafezinho ☕🙏",
  "Bora pra mais um dia de batalha! Foco nas metas 💪",
  "Dia corrido por aqui, mas sempre com gratidão ✨",
  "Sextou com a graça de Deus! Bom fim de semana a todos 🍻",
  "Mais um dia produtivo finalizado! Descanso merecido 🛋️",
  "Trabalho em equipe faz toda a diferença 👊🚀",
  "Almoço caprichado de hoje! Recarregando as energias 🥗",
  "Aquele clássico cafezinho da tarde pra salvar o expediente ☕",
  "Domingo de paz e descanso com a família ☀️",
  "Novos projetos saindo do papel! Vamos pra cima 🎯",
];

export const CASUAL_VOICE_NOTES = [
  "Opa beleza? Correria pura aqui mano, já te respondo com calma!",
  "Fala cara, tranquilo? Vi sua mensagem aqui, show de bola!",
  "Beleza meu querido, valeu pelo toque, tamo junto!",
  "Opa meu amigo, tudo em paz por aí? Depois me dá um alô!",
  "Fala parceiro, fechadíssimo então, qualquer coisa me avisa!",
];

export const FALLBACK_SCRIPTS: DialogueScript[] = [
  {
    id: "dia_a_dia_1",
    theme: "dia_a_dia",
    turns: [
      { speaker: "A", text: "Fala mano, tudo bem por aí?", reaction: "👍" },
      { speaker: "B", text: "Opa, tudo em paz! E contigo, como tá a correria?", reaction: "🙌" },
      { speaker: "A", text: "Bastante trabalho hoje cara, cafezinho salvando a tarde haha", reaction: "😂" },
      { speaker: "B", text: "Sei bem como é kkk aqui também tá uma loucura sem fim", reaction: "👊" },
      { speaker: "A", text: "Mas é isso aí, logo mais sextou", reaction: "🔥" },
      { speaker: "B", text: "Amém! Bom trampo aí parceiro, tamo junto!", reaction: "👍" },
    ],
  },
  {
    id: "dia_a_dia_2",
    theme: "dia_a_dia",
    turns: [
      { speaker: "A", text: "E aí cara, sumido! Como você tá?", reaction: "👋" },
      { speaker: "B", text: "E aí! Tudo certo por aqui, correria do dia a dia mesmo. E você?", reaction: "👍" },
      { speaker: "A", text: "Tudo bem também, só na batalha. Tempo virou aí também?", reaction: "🌧️" },
      { speaker: "B", text: "Nossa demais, esfriou do nada aqui hoje cedo", reaction: "🥶" },
      { speaker: "A", text: "Pois é, clima doido. Se cuida aí viu!", reaction: "👊" },
      { speaker: "B", text: "Valeu mano, pra você também! Abraço", reaction: "🙌" },
    ],
  },
  {
    id: "futebol_1",
    theme: "futebol",
    turns: [
      { speaker: "A", text: "Viu o jogo ontem mano?", reaction: "⚽" },
      { speaker: "B", text: "Vi sim cara, inacreditável aquele gol no final!", reaction: "😱" },
      { speaker: "A", text: "Achei que ia dar empate fácil, o time jogou muito nos acréscimos", reaction: "🔥" },
      { speaker: "B", text: "Pois é, os caras não desistiram. Domingo promete ser pedreira agora", reaction: "👊" },
      { speaker: "A", text: "Com certeza, clássico é clássico! Vai assistir onde?", reaction: "🤔" },
      { speaker: "B", text: "Devo colar em casa mesmo com a família. Bora ver depois se dá pra marcar um!", reaction: "👏" },
    ],
  },
  {
    id: "futebol_2",
    theme: "futebol",
    turns: [
      { speaker: "A", text: "Mano, seu time tá jogando demais esse ano hein", reaction: "🔥" },
      { speaker: "B", text: "Nem fala kkk até que enfim começou a acertar o passe!", reaction: "😂" },
      { speaker: "A", text: "O técnico conseguiu ajeitar a zaga, ficou bem mais consistente", reaction: "👍" },
      { speaker: "B", text: "Verdade, antes levava gol bobo todo jogo. Agora tomara que mantenha o ritmo", reaction: "🙌" },
      { speaker: "A", text: "Se mantiver leva o título fácil", reaction: "🏆" },
      { speaker: "B", text: "Tomara Deus! Vamos ver a próxima rodada", reaction: "👊" },
    ],
  },
  {
    id: "churrasco_1",
    theme: "churrasco",
    turns: [
      { speaker: "A", text: "E aí meu querido, animado pro fim de semana?", reaction: "🥩" },
      { speaker: "B", text: "Opa, com certeza! Precisando dar uma relaxada", reaction: "🍻" },
      { speaker: "A", text: "Tava pensando em acender a brasa no sábado, o que acha?", reaction: "🔥" },
      { speaker: "B", text: "Boa ideia demais! Posso levar aquela picanha e a cerveja", reaction: "👏" },
      { speaker: "A", text: "Fechou! Eu compro o carvão e as bebidas que faltarem", reaction: "👍" },
      { speaker: "B", text: "Show de bola, combinadíssimo então!", reaction: "👊" },
    ],
  },
  {
    id: "trabalho_1",
    theme: "trabalho",
    turns: [
      { speaker: "A", text: "Opa parceiro, conseguiu ver aquele relatório que te mandei?", reaction: "📄" },
      { speaker: "B", text: "Fala! Consegui sim, dei uma olhada rápida agora há pouco", reaction: "👍" },
      { speaker: "A", text: "Ficou claro os números ou acha que precisa detalhar mais alguma coisa?", reaction: "🤔" },
      { speaker: "B", text: "Achei bem estruturado, só a parte do comparativo mensal que vale destacar", reaction: "💡" },
      { speaker: "A", text: "Perfeito, vou fazer esse ajuste fino antes da reunião amanhã", reaction: "👏" },
      { speaker: "B", text: "Fechou, vai ficar excelente. Qualquer coisa me dá um toque!", reaction: "👊" },
    ],
  },
  {
    id: "tecnologia_1",
    theme: "tecnologia",
    turns: [
      { speaker: "A", text: "E aí mano, você que manja de celular, qual recomendaria até uns 2k?", reaction: "📱" },
      { speaker: "B", text: "Opa! Nessa faixa a linha Galaxy A ou os Redmi tão entregando muito", reaction: "💡" },
      { speaker: "A", text: "Bateria dura bem o dia todo? Meu foco é mais bateria e tela fluida", reaction: "🔋" },
      { speaker: "B", text: "Dura sim, tela AMOLED 120hz e bateria de 5000mAh. Vai tranquilo", reaction: "🔥" },
      { speaker: "A", text: "Show de bola, vou dar uma olhada nas promoções hoje", reaction: "👍" },
      { speaker: "B", text: "Se achar algum link com preço bom me avisa também!", reaction: "👊" },
    ],
  },
  {
    id: "compras_1",
    theme: "compras",
    turns: [
      { speaker: "A", text: "Fala meu amigo, chegou aquele pacote que você tava esperando?", reaction: "📦" },
      { speaker: "B", text: "Chegou hoje de manhã cara! Entrega rápida demais", reaction: "🚀" },
      { speaker: "A", text: "Veio tudo certinho ou teve que abrir reclamação?", reaction: "🤔" },
      { speaker: "B", text: "Veio 100%, muito bem embalado e funcionou de primeira", reaction: "👍" },
      { speaker: "A", text: "Que top, tava na dúvida se comprava lá. Vou pedir o meu", reaction: "🔥" },
      { speaker: "B", text: "Pode pedir sem medo, valeu cada centavo!", reaction: "👏" },
    ],
  },
];

export function getRandomReaction(): string {
  return NATURAL_REACTIONS[Math.floor(Math.random() * NATURAL_REACTIONS.length)];
}

export function getRandomStatusQuote(): string {
  return STATUS_STORIES_QUOTES[Math.floor(Math.random() * STATUS_STORIES_QUOTES.length)];
}

export function getRandomCasualVoiceNote(): string {
  return CASUAL_VOICE_NOTES[Math.floor(Math.random() * CASUAL_VOICE_NOTES.length)];
}

export function pickFallbackDialogue(theme?: string): DialogueScript {
  const filtered = theme && theme !== "todos"
    ? FALLBACK_SCRIPTS.filter((s) => s.theme === theme)
    : FALLBACK_SCRIPTS;

  const pool = filtered.length > 0 ? filtered : FALLBACK_SCRIPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Calcula duração de digitação humana com variação gaussiana (3 a 10s).
 */
export function calculateTypingDuration(textLength: number, minSec = 3, maxSec = 10): number {
  const minMs = minSec * 1000;
  const maxMs = maxSec * 1000;
  const charSpeedMs = textLength * 55;
  const clamped = Math.min(Math.max(charSpeedMs, minMs), maxMs);
  const jitter = Math.floor(Math.random() * 800) - 400;
  return Math.max(minMs, Math.min(clamped + jitter, maxMs));
}
