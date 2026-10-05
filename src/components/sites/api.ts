import type { WebsiteRunStatus } from "@/lib/sites/types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Não foi possível concluir a operação. Verifique a conexão e tente novamente.";
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data)) {
    const raw = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "";
    const message = raw.includes("READY — AWAITING CREDENTIALS")
      ? "Integração não configurada — ver Configurações."
      : response.status === 403 ? "Acesso não permitido. Solicite a liberação ao administrador."
      : response.status === 404 ? "Registro ou recurso não encontrado."
      : response.status === 409 ? "O projeto mudou ou há uma operação em andamento. Recarregue antes de tentar novamente."
      : response.status === 429 ? "Limite de uso atingido. Tente novamente mais tarde."
      : response.status === 413 ? "O conteúdo excede o limite permitido."
      : response.status === 400 || response.status === 415 ? "Dados inválidos. Revise os campos e os limites informados."
      : response.status === 401 ? "Sessão expirada. Entre novamente no painel."
      : "Não foi possível concluir a operação. Tente novamente.";
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export function jsonBody(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function isActiveRun(status: WebsiteRunStatus): boolean {
  return ["queued", "planning", "editing", "validating"].includes(status);
}

export function friendlyRunError(error: string | null): string {
  if (error?.includes("READY — AWAITING CREDENTIALS")) return "Integração não configurada — ver Configurações.";
  return error ?? "A execução não foi concluída. Os arquivos anteriores foram preservados. Revise o pedido e tente novamente.";
}

export const selectClass = "min-h-10 w-full rounded-lg border border-input bg-[#0f172a] text-slate-100 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 [color-scheme:dark]";
