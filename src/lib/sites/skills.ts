import { getSitesDb } from "./server";
import type { WebsiteSkill } from "./types";
import { WebsiteInstructionError, assertWebsiteUuid } from "./prompts";

const definitions: Array<[string, string, string, string[], number, WebsiteSkill["trigger_mode"], string, string]> = [
  ["impeccable-design", "Impeccable Design (Anti-AI)", "design", ["impeccable", "design", "anti-ai", "original", "ui", "craft", "layout", "typography"], 100, "always", "Diretrizes mestras de design autoral e eliminação de clichês de IA (pbakaus/impeccable). Cria sites com direção de arte premiada, tipografia intencional, ritmo visual orgânico e sem nenhum clichê de template.", `DIRETRIZ MESTRA IMPECCABLE DESIGN (pbakaus/impeccable — DESIGN DE ALTO VALOR):
Você é um Diretor de Criação premiado projetando um site exclusivo e autoral com padrão visual de agência de R$ 2.000 a R$ 5.000. Rejeite designs covardes, tímidos, genéricos ou com cara de template de IA.

1. Processo (Direção de Arte & Identidade Sob Medida):
- O brief e as variáveis do lead são a verdade soberana (nome, segmento, cidade, endereço, serviços reais, telefone/WhatsApp). Identifique o tom e a personalidade da marca antes de escrever código.
- Paleta de Cores Autoral por Nicho (PROIBIDO roxo meia-noite #090d16 e verde template #1d5037):
  * Advocacia / Jurídico: tons nobres e solenes (azul marinho profundo #0b172a, grafite carvão #141416, linho/marfim off-white #faf9f6, acentos champanhe/bronze #c5a059, display com serifas de prestígio).
  * Pet Shop / Veterinária: tons acolhedores e orgânicos (terracota suave #d96b43, sálvia #607c6f, âmbar dourado #f4a261, off-white macio #faf7f2, cantos amigáveis).
  * Saúde / Odonto / Estética: pureza serena e limpa (ardósia suave #334155, ciano/menta discreto #0ea5e9 ou #0d9488, branco pérola #fcfdfe com sombras de seda).
  * Gastronomia / Restaurante: sensorial e acolhedor (carvão profundo #141312, bordô/vinho #6b1d2f, linho tostado #f5f0eb, acentos açafrão).
  * Consultoria / B2B / Geral: monocromático quente de alto contraste com acento de alta precisão (ultramarino #2563eb ou esmeralda #059669).
- Tinting de Neutros: NUNCA use preto puro (#000000) nem cinza neutro (#808080). Sempre tinja as cores escuras e fundos com o matiz da marca. Em fundos escuros ou coloridos, NUNCA use texto cinza genérico: derive o texto secundário a partir da cor de frente com opacidade (ex: rgba(255,255,255,0.72)).

2. Checks (O Piso de Qualidade Técnica — Craft Floor & Verificações Mecânicas):
- Contraste WCAG AA: No mínimo 4.5:1 no corpo e placeholders, no mínimo 3:1 em títulos e botões. Em fundos coloridos, NUNCA texto cinza.
- Profundidade Física & Sombras: Sombras reais com offset Y e dispersão suave (ex: box-shadow: 0 10px 30px -10px rgba(0,0,0,0.08), 0 20px 48px -15px rgba(0,0,0,0.12)). BARRADO: halos coloridos zero-offset e blocos neobrutalistas rígidos (4px 4px 0). Declare elevação uma única vez: borda sutil OU sombra, nunca card-fantasma (1px borda sob sombra difusa).
- Ritmo Espacial & Proporção:
  * Agrupamento firme de blocos locais (título, descrição e CTA próximos).
  * Separação generosa entre seções: padding: clamp(5rem, 10vw, 8rem) 0.
  * Regra Áurea Impeccable: Sempre significativamente mais espaço ACIMA de um título do que abaixo dele (margin-top: 3.5rem; margin-bottom: 0.75rem).
- Tipografia Editorial & Medida de Leitura:
  * Títulos de alto impacto: fluidos com clamp(2.5rem, 5.5vw, 4.5rem), entrelinha compacta (1.05 a 1.15) e tracking refinado (-0.025em a -0.035em).
  * text-wrap: balance em todos os títulos para eliminar linhas órfãs.
  * Largura de leitura confortável no corpo: entre 55ch e 75ch (max-width: 65ch) com entrelinha respirável (1.65 a 1.8).
  * Saltos claros de escala visual e peso (H1 > H2 > H3 > Label), evitando tamanhos quase idênticos.
- Superfícies Nativas Customizadas (Browser Surfaces):
  * Seleção de texto temática: ::selection { background: var(--brand-primary); color: #ffffff; }
  * Anel de foco nítido: :focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }
  * Caret customizado: caret-color: var(--brand-primary);
  * Underline offset em links: text-underline-offset: 4px;
  * Números tabulares em dados e telefones: font-variant-numeric: tabular-nums;
  * Scrollbar fina temática: scrollbar-width: thin; scrollbar-color: var(--brand-primary) transparent;
- Movimento e Micro-interações:
  * Transições suaves com curva exponencial (cubic-bezier(0.16, 1, 0.3, 1)).
  * Elevação interativa sutil em botões e cartões (transform: translateY(-2px) no hover).
  * Proibido animar a imagem em si no hover; anime o container.

3. Anti-patterns (Bans e Clichês Refutados — Zero AI-SLOP):
- BARRADO: Grid clichê de 3 cards idênticos de ícone + título + parágrafo (cards são containers preguiçosos; cards aninhados são proibidos).
- BARRADO: Template de métricas no Hero (10k clientes atendidos, 99% satisfação, contadores falsos).
- BARRADO: Kickers ou eyebrows repetitivos acima de títulos (Nossos Serviços, Sobre Nós). O título carrega seu próprio peso!
- BARRADO: Números de seção (01 / 02 / 03) a menos que a sequência em si carregue instrução indispensável.
- BARRADO: Texto com degradê ou gradiente rainbow (background-clip: text). Ênfase vem de peso ou escala.
- BARRADO: Glassmorphism decorativo genérico como default.
- BARRADO: Faixas coloridas laterais (border-left: 3px solid).
- BARRADO: Emojis ou símbolos Unicode soltos como ícones. Use ícones vetoriais SVG inline desenhados com traço consistente de 1.5px ou 2px.
- BARRADO: Copywriting vazio (Soluções inovadoras, Transforme seu negócio, Excelência e tradição). Use os serviços reais, localização e diferenciais concretos do cliente.

4. DoD (Definição de Pronto — Padrão Agência R$ 2.000):
- Site completo, funcional e autoral em React 19 + TypeScript + CSS centralizado em src/App.tsx e src/styles.css (sem arquivos obsoletos de template).
- Header fixo com efeito glassmorphism suave (backdrop-filter: blur(16px)), identidade da marca, navegação fluida por âncoras e botão direto.
- Hero marcante com proposta de valor clara, prova de autoridade concreta e duplo CTA (ação principal + WhatsApp).
- Seções de narrativa em 2 colunas assimétricas, serviços em lista editorial ou accordion expansível e metodologia de atendimento.
- Seção de Perguntas Frequentes (FAQ) interativa com accordion (estado React useState).
- Formulário de Contato completo e validado, com feedback visual de envio.
- Botão flutuante do WhatsApp no canto inferior direito com mensagem pré-formatada (https://wa.me/55...).
- Footer institucional elegante com dados de contato, endereço completo, horário de funcionamento e copyright.
- Responsividade total de 320px até 1440px sem overflow horizontal e com zero erros de compilação.`],
];

export const BUILTIN_WEBSITE_SKILLS: readonly WebsiteSkill[] = Object.freeze(definitions.map(([slug, name, category, tags, priority, trigger_mode, description, instructions]) => Object.freeze({
  id: `builtin:${slug}`, client_id: null, slug, name, category, tags: Object.freeze(tags) as unknown as string[], instructions,
  description, priority, trigger_mode, is_enabled: true, is_builtin: true, version: 2,
})));

export type WebsiteSkillInput = Pick<WebsiteSkill, "name" | "slug" | "description" | "instructions" | "category" | "tags" | "priority" | "trigger_mode" | "is_enabled">;
const fields = new Set(["name", "slug", "description", "instructions", "category", "tags", "priority", "trigger_mode", "is_enabled"]);

export function validateSkillInput(value: unknown, partial = false): Partial<WebsiteSkillInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebsiteInstructionError("Skill inválida.");
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).length || Object.keys(input).some((key) => !fields.has(key))) throw new WebsiteInstructionError("Campos de skill inválidos.");
  const result: Record<string, unknown> = {};
  for (const [key, max] of [["name", 100], ["slug", 80], ["description", 500], ["instructions", 12000], ["category", 60]] as const) {
    if (!(key in input)) {
      if (!partial && ["name", "slug", "instructions"].includes(key)) throw new WebsiteInstructionError(`Campo obrigatório: ${key}.`);
      continue;
    }
    if (typeof input[key] !== "string" || input[key].length > max || (key !== "description" && !input[key].trim())) throw new WebsiteInstructionError(`Campo inválido: ${key}.`);
    result[key] = input[key].trim();
  }
  if (typeof result.slug === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)) throw new WebsiteInstructionError("Slug inválido.");
  if ("tags" in input) {
    if (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 60)) throw new WebsiteInstructionError("Tags inválidas.");
    result.tags = [...new Set(input.tags.map((tag: string) => tag.trim().toLowerCase()))];
  }
  if ("priority" in input) {
    if (!Number.isInteger(input.priority) || (input.priority as number) < 0 || (input.priority as number) > 100) throw new WebsiteInstructionError("Prioridade deve estar entre 0 e 100.");
    result.priority = input.priority;
  }
  if ("trigger_mode" in input) {
    if (!["always", "automatic", "manual"].includes(input.trigger_mode as string)) throw new WebsiteInstructionError("Modo de ativação inválido.");
    result.trigger_mode = input.trigger_mode;
  }
  if ("is_enabled" in input) {
    if (typeof input.is_enabled !== "boolean") throw new WebsiteInstructionError("Estado inválido.");
    result.is_enabled = input.is_enabled;
  }
  return result;
}

export async function getEffectiveSkills(clientId: string): Promise<WebsiteSkill[]> {
  assertWebsiteUuid(clientId);
  const { data, error } = await getSitesDb().from("website_skills").select("*").eq("client_id", clientId).order("slug").limit(101);
  if (error) throw new WebsiteInstructionError("Não foi possível carregar as skills.", 503);
  if ((data?.length ?? 0) > 100) throw new WebsiteInstructionError("Limite de skills excedido.", 409);
  const privateSkills = (data ?? []) as WebsiteSkill[];
  const overrides = new Map(privateSkills.filter((item) => item.client_id === clientId).map((item) => [item.slug, item]));
  const builtins = BUILTIN_WEBSITE_SKILLS.map((builtin) => {
    const override = overrides.get(builtin.slug);
    if (!override) return builtin;
    return { ...builtin, ...override, id: builtin.id, client_id: builtin.client_id, slug: builtin.slug, is_builtin: true, priority: builtin.priority, trigger_mode: builtin.trigger_mode, tags: [...(override.tags ?? builtin.tags)] };
  });
  return [...builtins, ...privateSkills.filter((item) => item.client_id === clientId && !BUILTIN_WEBSITE_SKILLS.some((builtin) => builtin.slug === item.slug))];
}

export async function createWebsiteSkill(clientId: string, input: unknown): Promise<WebsiteSkill> {
  assertWebsiteUuid(clientId);
  const value = validateSkillInput(input);
  if (BUILTIN_WEBSITE_SKILLS.some((item) => item.slug === value.slug)) throw new WebsiteInstructionError("Use PATCH no ID builtin para criar um override privado.", 409);
  const { count, error: countError } = await getSitesDb().from("website_skills").select("id", { count: "exact", head: true }).eq("client_id", clientId);
  if (countError) throw new WebsiteInstructionError("Não foi possível verificar o limite de skills.", 503);
  if (count === null || count >= 100) throw new WebsiteInstructionError("Limite de 100 skills privadas atingido.", 409);
  const { data, error } = await getSitesDb().from("website_skills").insert({ description: "", category: "custom", tags: [], priority: 50, trigger_mode: "manual", is_enabled: true, ...value, client_id: clientId, is_builtin: false, version: 1 }).select("*").single();
  if (error) throw new WebsiteInstructionError("Não foi possível criar a skill. Verifique se o slug já existe.", 409);
  return data as WebsiteSkill;
}

export async function updateWebsiteSkill(clientId: string, id: string, input: unknown): Promise<WebsiteSkill> {
  assertWebsiteUuid(clientId);
  const value = validateSkillInput(input, true);
  const builtin = BUILTIN_WEBSITE_SKILLS.find((item) => item.id === id);
  if (!builtin) assertWebsiteUuid(id);
  if (builtin && value.slug && value.slug !== builtin.slug) throw new WebsiteInstructionError("O slug builtin é imutável.");
  if (!builtin && value.slug && BUILTIN_WEBSITE_SKILLS.some((item) => item.slug === value.slug)) throw new WebsiteInstructionError("Slug reservado.");
  let query = getSitesDb().from("website_skills").select("*").eq("client_id", clientId);
  query = builtin ? query.eq("slug", builtin.slug) : query.eq("id", id);
  const { data: current, error: readError } = await query.maybeSingle();
  if (readError) throw new WebsiteInstructionError("Não foi possível carregar a skill.", 503);
  if (!current && !builtin) throw new WebsiteInstructionError("Skill não encontrada.", 404);
  if (!current && builtin) {
    const { id: _id, client_id: _clientId, ...base } = builtin;
    const { data, error } = await getSitesDb().from("website_skills").insert({ ...base, ...value, client_id: clientId, is_builtin: false, version: builtin.version + 1 }).select("*").single();
    if (error) throw new WebsiteInstructionError("Conflito ao criar override privado.", 409);
    return { ...data, id: builtin.id, is_builtin: true } as WebsiteSkill;
  }
  const { data, error } = await getSitesDb().from("website_skills").update({ ...value, version: current.version + 1, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("id", current.id).eq("version", current.version).select("*").maybeSingle();
  if (error || !data) throw new WebsiteInstructionError("Skill alterada por outra operação. Recarregue e tente novamente.", 409);
  return { ...data, id: builtin?.id ?? data.id } as WebsiteSkill;
}

export async function deleteWebsiteSkill(clientId: string, id: string): Promise<void> {
  assertWebsiteUuid(clientId);
  const builtin = BUILTIN_WEBSITE_SKILLS.find((item) => item.id === id);
  if (!builtin) assertWebsiteUuid(id);
  let query = getSitesDb().from("website_skills").delete().eq("client_id", clientId);
  query = builtin ? query.eq("slug", builtin.slug) : query.eq("id", id);
  const { error } = await query;
  if (error) throw new WebsiteInstructionError("Não foi possível excluir a skill.", 503);
}
