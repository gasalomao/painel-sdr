import type { ModelMode, WebsiteBuild, WebsiteModel, WebsiteProject, WebsiteRunStatus, WebsiteSkill } from "./types";

export const CLIENT_FIELDS = [
  ["name", "Nome"], ["segment", "Segmento"], ["phone", "Telefone"],
  ["whatsapp", "WhatsApp"], ["website", "Site atual"], ["city", "Cidade"],
  ["address", "Endereço"], ["description", "Descrição"], ["services", "Serviços"], ["notes", "Observações"],
] as const;

export function runStatusLabel(status: WebsiteRunStatus): string {
  return {
    queued: "Na fila...", planning: "Pensando...", editing: "Criando e editando arquivos...",
    validating: "Validando o site...", completed: "Concluída", failed: "Falhou", cancelled: "Cancelada",
  }[status] ?? "Estado desconhecido";
}

export function projectStatusLabel(status: WebsiteProject["status"]): string {
  return { draft: "Rascunho", published: "Publicado", archived: "Arquivado" }[status];
}

export function modelModeLabel(mode: ModelMode): string {
  return { auto: "Automático", quality: "Qualidade", economy: "Econômico", manual: "Manual" }[mode];
}

export function matchesModelFilters(model: WebsiteModel, tools: boolean, vision: boolean): boolean {
  return (!tools || model.supportsTools) && (!vision || model.inputModalities?.includes("image") === true);
}

export function formatRelative(date: string | null | undefined, now = Date.now()): string {
  if (!date || !Number.isFinite(Date.parse(date))) return "Data indisponível";
  const seconds = (Date.parse(date) - now) / 1000;
  if (Math.abs(seconds) < 60) return "agora mesmo";
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "always" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return "agora mesmo";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const TOOL_ACTIVITY: Record<string, readonly [string, string]> = {
  list: ["Listando arquivos", "Arquivos listados"],
  read: ["Lendo arquivo", "Leitura de arquivo concluída"],
  read_files: ["Lendo arquivos", "Leitura de arquivos concluída"],
  create: ["Criando arquivo", "Arquivo criado"],
  write: ["Atualizando arquivo", "Arquivo atualizado"],
  patch: ["Editando arquivo", "Arquivo editado"],
  delete: ["Excluindo arquivo", "Arquivo excluído"],
  rename: ["Renomeando arquivo", "Arquivo renomeado"],
  search: ["Buscando nos arquivos", "Busca nos arquivos concluída"],
  get_context: ["Consultando informações confirmadas", "Informações confirmadas consultadas"],
  assets: ["Consultando imagens e anexos", "Imagens e anexos consultados"],
  checkpoint: ["Salvando ponto de restauração", "Ponto de restauração salvo"],
  restore: ["Recuperando ponto de restauração", "Ponto de restauração recuperado"],
  run_validation: ["Verificando estrutura e conteúdo", "Verificação estática concluída"],
};

function activityPath(value: unknown): string {
  return typeof value === "string" && value.length <= 180
    && /^(?:index\.html|(?:src|public)\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)$/.test(value) ? value : "";
}

export function parseSystemEvent(content: string): string {
  try {
    const event = record(JSON.parse(content));
    if (Array.isArray(event.active_skills) && event.active_skills.length === 0) return "Nenhuma skill ativa nesta execução.";
    if (Array.isArray(event.active_skills) && event.active_skills.length > 0) {
      const validNames = event.active_skills.filter((s): s is string => typeof s === "string" && Boolean(s.trim()));
      if (validNames.length > 0) return `Skills ativas: ${validNames.join(" · ")}`;
    }
    if (event.skill_analysis && typeof event.skill_analysis === "object") {
      const sa = event.skill_analysis as Record<string, unknown>;
      if (typeof sa.message === "string" && sa.message.trim()) return sa.message;
    }
    const call = record(event.model_call);
    const model = typeof call.model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,159}$/.test(call.model) ? ` ${call.model}` : "";
    if (call.status === "started") return `Modelo${model}: consulta iniciada; aguardando resposta.`;
    if (call.status === "completed") return `Modelo${model}: resposta recebida.`;
    if (call.status === "failed") return `Modelo${model}: falha na consulta.`;
    if (event.checkpoint) return "Ponto de restauração salvo.";
    if (Array.isArray(event.vision_assets)) return `${event.vision_assets.length} imagem(ns) preparada(s) para análise.`;
    if (event.usage) return "Uso do modelo registrado.";
    const validation = record(event.validation);
    if (event.validation) {
      if (validation.status === "unconfigured") return "Ambiente E2B não configurado. Renderização não verificada; site permanece como rascunho.";
      if (validation.status === "started") return "Verificando o site...";
      const counts = [validation.errorCount, validation.warningCount].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
        ? ` (${validation.errorCount} erro(s), ${validation.warningCount} aviso(s))` : "";
      if (validation.status === "failed" || validation.success === false || record(validation.qa).passed === false) return `A validação identificou ajustes necessários${counts}.`;
      return validation.success === true ? `Validação técnica concluída com sucesso${counts}.` : "Validação do site registrada.";
    }
    const tool = typeof event.tool === "string" && Object.hasOwn(TOOL_ACTIVITY, event.tool) ? TOOL_ACTIVITY[event.tool] : undefined;
    if (event.status === "started" && typeof event.tool === "string") {
      const path = activityPath(event.path);
      return `${tool?.[0] ?? "Executando operação do agente"}${path ? `: ${path}` : ""}...`;
    }
    const rawResult = event.role === "tool" ? event.content : typeof event.tool === "string" ? event.result : event;
    const result = record(typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult);
    if (result.error) return "Não foi possível concluir uma operação do agente.";
    if (typeof result.passed === "boolean") return result.passed ? "Verificação estática aprovada; renderização ainda não verificada." : "Verificação estática requer ajustes.";
    if (tool) {
      const path = activityPath(result.saved) || activityPath(event.path);
      return `${tool[1]}${path ? `: ${path}` : ""}.`;
    }
    const saved = activityPath(result.saved);
    if (saved) return `Arquivo atualizado: ${saved}`;
    if (result.restored === true) return "Ponto de restauração recuperado.";
    if (event.role === "tool") return "Arquivos e dados do projeto consultados.";
  } catch {
    if (content.startsWith("READY — AWAITING CREDENTIALS")) return "Integração não configurada — ver Configurações.";
    if (content === "Execução cancelada.") return content;
  }
  return "Atividade interna do agente registrada.";
}

export function assistantText(content: string): string {
  try {
    const value = record(JSON.parse(content));
    if (value.role === "assistant") return typeof value.content === "string" && value.content.trim() ? value.content : "Preparando alterações nos arquivos...";
    if (typeof value.passed === "boolean" && typeof value.summary === "string") return value.summary;
    return "Análise do agente registrada.";
  } catch { return /^[\s]*[\[{]/.test(content) ? "Análise do agente registrada." : content; }
}

export function tokenUsage(content: string): number {
  try {
    const total = record(record(JSON.parse(content)).usage).totalTokens;
    return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : 0;
  } catch { return 0; }
}

export function safeSiteUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function editableFile(path: string, content: string): boolean {
  return !["package.json", "tsconfig.json", "vite.config.ts"].includes(path.replace(/^\//, ""))
    && /\.(ts|tsx|css|html|json)$/.test(path) && new TextEncoder().encode(content).length <= 100 * 1024;
}

export function isPublishableBuild(build: Pick<WebsiteBuild, "success" | "status" | "qa" | "screenshots">): boolean {
  return build.success === true && build.status === "ready" && build.qa?.passed === true && Boolean(build.qa.visual_review?.trim())
    && Boolean(build.screenshots?.desktop?.startsWith("data:image/png;base64,iVBOR"))
    && Boolean(build.screenshots?.mobile?.startsWith("data:image/png;base64,iVBOR"));
}

export function modelPriceLabel(model: WebsiteModel): string | null {
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  if (!Number.isFinite(prompt) || prompt < 0 || !Number.isFinite(completion) || completion < 0) return null;
  const perMillion = (value: number): string => {
    const total = value * 1_000_000;
    return total === 0 ? "grátis" : total < 0.01 ? "< US$ 0,01" : `US$ ${total.toFixed(2).replace(".", ",")}`;
  };
  return `Entrada ${perMillion(prompt)} / M tokens · Saída ${perMillion(completion)} / M tokens`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOverrideSkill(skill: WebsiteSkill): boolean {
  return skill.is_builtin === true && typeof skill.client_id === "string";
}

export function isSelectableSkill(skill: WebsiteSkill): boolean {
  return !skill.is_builtin && skill.is_enabled && skill.trigger_mode === "manual" && UUID_PATTERN.test(skill.id);
}

export function skillCategoryLabel(category: string): string {
  return ({ design: "Design", quality: "Qualidade", content: "Conteúdo", seo: "SEO", custom: "Personalizada" } as Record<string, string>)[category] ?? category;
}

export function skillTriggerLabel(mode: WebsiteSkill["trigger_mode"]): string {
  return { always: "Sempre", automatic: "Automática por tags", manual: "Manual (seleção por projeto)" }[mode];
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isModelSelectionLocked(state: {
  activeRun: boolean;
  sending?: boolean;
  updating?: boolean;
  archived?: boolean;
}): boolean {
  return Boolean(state.activeRun || state.sending || state.updating || state.archived);
}

export type CompletionNotice = {
  type: "success" | "info" | "warning";
  message: string;
};

export function completionNotice(
  kind: "agent" | "build" | undefined,
  latestBuild: Pick<WebsiteBuild, "status" | "success" | "qa" | "screenshots"> | null | undefined
): CompletionNotice {
  if (kind === "build") {
    return { type: "success", message: "Validação concluída." };
  }

  if (!latestBuild) {
    return { type: "success", message: "Alterações concluídas! Visualização atualizada." };
  }

  if (latestBuild.status === "unconfigured") {
    return {
      type: "info",
      message: "Alterações concluídas. Ambiente de validação não configurado; rascunho salvo sem verificação de renderização.",
    };
  }

  if (latestBuild.status === "failed" || !latestBuild.success || latestBuild.qa?.passed === false) {
    return {
      type: "warning",
      message: "Execução concluída, mas a validação técnica identificou ajustes necessários. Verifique a lista de validações.",
    };
  }

  if (isPublishableBuild(latestBuild)) {
    return {
      type: "success",
      message: "Alterações concluídas e validadas! Visualização atualizada.",
    };
  }

  return {
    type: "success",
    message: "Alterações concluídas! Visualização atualizada.",
  };
}

export type UsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  isEstimated: boolean;
  costUsd: number | null;
};

export function usageBreakdown(rawSystemContents: string[]): UsageBreakdown {
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let isEstimated = false;
  let costUsd: number | null = null;

  for (const raw of rawSystemContents) {
    try {
      const parsed = record(JSON.parse(raw));
      const u = record(parsed.usage);
      if (typeof u.totalTokens === "number" && Number.isSafeInteger(u.totalTokens) && u.totalTokens >= 0) {
        totalTokens += u.totalTokens;
      }
      const inp = typeof u.promptTokens === "number" ? u.promptTokens : typeof u.inputTokens === "number" ? u.inputTokens : 0;
      if (Number.isSafeInteger(inp) && inp >= 0) inputTokens += inp;

      const out = typeof u.completionTokens === "number" ? u.completionTokens : typeof u.outputTokens === "number" ? u.outputTokens : 0;
      if (Number.isSafeInteger(out) && out >= 0) outputTokens += out;

      const cache = typeof u.cachedTokens === "number" ? u.cachedTokens : 0;
      if (Number.isSafeInteger(cache) && cache >= 0) cachedTokens += cache;

      if (u.estimated === true) isEstimated = true;

      if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0) {
        costUsd = (costUsd ?? 0) + u.costUsd;
      }
    } catch {
      // ignore malformed system events
    }
  }

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    isEstimated,
    costUsd,
  };
}

export function usageLabels(breakdown: UsageBreakdown): {
  tokensText: string;
  estimatedBadge: string | null;
  costText: string;
} {
  const parts: string[] = [];
  if (breakdown.inputTokens > 0) parts.push(`${breakdown.inputTokens.toLocaleString("pt-BR")} entrada`);
  if (breakdown.outputTokens > 0) parts.push(`${breakdown.outputTokens.toLocaleString("pt-BR")} saída`);
  if (breakdown.cachedTokens > 0) parts.push(`${breakdown.cachedTokens.toLocaleString("pt-BR")} cache`);

  const breakdownSuffix = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  const tokensText = `${breakdown.totalTokens.toLocaleString("pt-BR")} tokens${breakdownSuffix}`;
  const estimatedBadge = breakdown.isEstimated ? "Estimado" : null;

  let costText = "Custo: não informado pelo provedor";
  if (breakdown.costUsd !== null) {
    costText = breakdown.costUsd === 0
      ? "Custo: Gratuito / isento"
      : `Custo registrado: US$ ${breakdown.costUsd.toFixed(4).replace(".", ",")}`;
  }

  return {
    tokensText,
    estimatedBadge,
    costText,
  };
}
