/**
 * Variáveis de template — usadas tanto no prompt do agente quanto no template
 * do disparo em massa. Resolvidas em runtime.
 *
 * Variáveis estáticas suportadas:
 *   {{saudacao}}      → "Bom dia" | "Boa tarde" | "Boa noite" | "Boa madrugada" (hora SP)
 *   {{nome_empresa}}  → nome do negócio do lead (do CRM)
 *   {{primeiro_nome}} → primeira palavra do nome_empresa (heurística simples)
 *   {{nome}}          → push_name do contato (nome do WhatsApp), com fallback pro nome_empresa
 *   {{telefone}}      → número limpo do remoteJid
 *   {{ramo}}          → ramo_negocio do lead
 *   {{categoria}}     → categoria do lead
 *   {{endereco}}      → endereço do lead
 *   {{website}}       → website do lead
 *   {{avaliacao}}     → avaliação (Google) do lead
 *   {{reviews}}       → quantidade de reviews do lead
 *   {{status}}        → status do lead no CRM
 *   {{data}}          → "23/04/2026"
 *   {{hora}}          → "14:30"
 *
 * Variáveis dinâmicas: qualquer chave em ctx.variables é resolvida automaticamente.
 *   Ex: salvou {orcamento: "R$ 5k"} via tool save_variables → {{orcamento}} funciona no prompt.
 */

export type TemplateContext = {
  remoteJid?: string;
  nome_negocio?: string | null;
  ramo_negocio?: string | null;
  push_name?: string | null;
  telefone?: string | null;
  endereco?: string | null;
  categoria?: string | null;
  website?: string | null;
  avaliacao?: number | string | null;
  reviews?: number | string | null;
  status?: string | null;
  // Vars dinâmicas capturadas pelo funil (sessions.variables)
  variables?: Record<string, any> | null;
  // permite override do "agora" (útil em testes)
  now?: Date;
};

/**
 * Saudação baseada no horário local de Brasília (BRT, GMT-3).
 *   00–05 → Boa madrugada
 *   06–11 → Bom dia
 *   12–17 → Boa tarde
 *   18–23 → Boa noite
 */
export function greetingFor(date: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  if (hour >= 0 && hour < 6) return "Boa madrugada";
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function cleanPhone(jid?: string | null): string {
  return (jid || "").replace(/@.*$/, "").replace(/\D/g, "");
}

function firstName(name?: string | null): string {
  if (!name) return "";
  // Remove sufixos comuns ("Ltda", "ME", "Advocacia") pra pegar a 1a palavra mais natural
  const cleaned = name.replace(/\b(ltda|me|eireli|s\.?a\.?|advocacia|escritório|escritorio)\b\.?/gi, "").trim();
  return cleaned.split(/\s+/)[0] || "";
}

export function renderTemplate(template: string, ctx: TemplateContext = {}): string {
  if (!template) return "";
  const now = ctx.now || new Date();

  // Nome preferencial: push_name do WhatsApp (mais humano), depois primeiro nome da empresa.
  const pushFirst = firstName(ctx.push_name);
  const empresaFirst = firstName(ctx.nome_negocio);
  const nomeFinal = pushFirst || empresaFirst || "";

  const phone = ctx.telefone || cleanPhone(ctx.remoteJid);

  const baseMap: Record<string, string> = {
    saudacao:      greetingFor(now),
    nome_empresa:  ctx.nome_negocio || "",
    primeiro_nome: empresaFirst,
    nome:          nomeFinal,
    push_name:     ctx.push_name || "",
    telefone:      phone,
    ramo:          ctx.ramo_negocio || "",
    categoria:     ctx.categoria || "",
    endereco:      ctx.endereco || "",
    website:       ctx.website || "",
    avaliacao:     ctx.avaliacao != null ? String(ctx.avaliacao) : "",
    reviews:       ctx.reviews   != null ? String(ctx.reviews)   : "",
    status:        ctx.status || "",
    data:          new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(now),
    hora:          new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(now),
  };

  // Variáveis dinâmicas do funil têm prioridade quando presentes (ex: orcamento, cargo).
  // Não sobrescrevem variáveis-base se forem null/vazias — preserva fallback do CRM.
  const dynamicMap: Record<string, string> = {};
  if (ctx.variables && typeof ctx.variables === "object") {
    for (const [k, v] of Object.entries(ctx.variables)) {
      if (v == null) continue;
      const s = typeof v === "string" ? v : String(v);
      if (s.trim()) dynamicMap[k.toLowerCase()] = s;
    }
  }

  return template.replace(/\{\{\s*([a-z_][\w]*)\s*\}\}/gi, (full, key: string) => {
    const k = String(key).toLowerCase();
    if (dynamicMap[k] !== undefined) return dynamicMap[k];
    if (baseMap[k] !== undefined) return baseMap[k];
    return full;
  });
}

/** Lista de variáveis pra mostrar como chips na UI. */
export const TEMPLATE_VARIABLES = [
  { key: "saudacao",      label: "Saudação",     hint: "Bom dia / Boa tarde / Boa noite (hora SP)" },
  { key: "nome",          label: "Nome",         hint: "Nome do contato (push_name) com fallback pra empresa" },
  { key: "nome_empresa",  label: "Nome empresa", hint: "Do CRM (nome_negocio)" },
  { key: "primeiro_nome", label: "1ª palavra",   hint: "Primeira palavra do nome da empresa" },
  { key: "ramo",          label: "Ramo",         hint: "Ramo de negócio do CRM" },
  { key: "categoria",     label: "Categoria",    hint: "Categoria do lead (Google)" },
  { key: "endereco",      label: "Endereço",     hint: "Endereço do lead" },
  { key: "website",       label: "Website",      hint: "Site do lead" },
  { key: "avaliacao",     label: "Avaliação",    hint: "Nota do Google (1-5)" },
  { key: "reviews",       label: "Reviews",      hint: "Qtd. de avaliações" },
  { key: "telefone",      label: "Telefone",     hint: "Número do WhatsApp" },
  { key: "data",          label: "Data",         hint: "Data atual DD/MM/AAAA" },
  { key: "hora",          label: "Hora",         hint: "Hora atual HH:MM" },
] as const;
