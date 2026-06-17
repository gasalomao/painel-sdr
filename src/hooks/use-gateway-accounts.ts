"use client";

/**
 * Lê as contas logadas no CONECTOR LOCAL (`/api/gateway-proxy` action=status) e
 * devolve um índice por provedor canônico. Usado nos seletores de modelo para
 * mostrar QUAL apelido está vinculado a cada subgrupo do Gateway de Assinatura.
 *
 * - Falha silenciosamente pra usuário não-admin (a API só responde 200 a
 *   admin). Sem accounts → seletor renderiza igual a antes; nada quebra.
 * - Cache por aba: 1 fetch ao montar + revalida a cada 30s. Não fica martelando.
 * - Esta é uma "dica" visual; quem decide qual conta atende cada request é o
 *   próprio binário do conector (rotação automática).
 */

import { useEffect, useState } from "react";

export type GatewayAccount = {
  name: string;
  provider: string;          // canônico: gemini|claude|openai|antigravity|...
  email?: string;
  label?: string;
  createdAt?: string;
};

let cached: { at: number; accounts: GatewayAccount[] } | null = null;
const TTL_MS = 30_000;

async function fetchAccounts(): Promise<GatewayAccount[]> {
  try {
    const r = await fetch("/api/gateway-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    if (!d?.success) return [];
    const accs = Array.isArray(d?.status?.accounts) ? d.status.accounts : [];
    return accs.map((a: any) => ({
      name: String(a?.name || ""),
      provider: String(a?.provider || "").toLowerCase(),
      email: a?.email ? String(a.email) : undefined,
      label: a?.label ? String(a.label) : undefined,
      createdAt: a?.createdAt ? String(a.createdAt) : undefined,
    })).filter((a: GatewayAccount) => a.name);
  } catch {
    return [];
  }
}

export function useGatewayAccounts() {
  const [accounts, setAccounts] = useState<GatewayAccount[]>(() => cached?.accounts || []);

  useEffect(() => {
    let cancelled = false;
    const fresh = cached && Date.now() - cached.at < TTL_MS;
    if (fresh) {
      setAccounts(cached!.accounts);
      return;
    }
    fetchAccounts().then((accs) => {
      if (cancelled) return;
      cached = { at: Date.now(), accounts: accs };
      setAccounts(accs);
    });
    return () => { cancelled = true; };
  }, []);

  return accounts;
}

/**
 * Apelido amigável de UMA conta. Ordem: apelido → email → "Conta sem nome".
 * Mantida curtinha pra caber em rótulo de optgroup.
 */
export function accountFriendlyName(a: GatewayAccount): string {
  if (a.label) return a.label;
  if (a.email) return a.email;
  return "Conta sem nome";
}

/**
 * Famílias (subGroupLabel do agrupamento de modelos) que cada provedor do
 * conector consegue atender. Antigravity é uma conta Google que libera vários
 * modelos de uma vez — aparece em quase todos os subgrupos do Gateway.
 */
const FAMILY_TO_PROVIDERS: Record<string, string[]> = {
  Gemini: ["gemini", "antigravity"],
  Claude: ["claude", "antigravity"],
  "GPT (OpenAI)": ["openai", "antigravity"],
  Grok: ["antigravity"],
};

/**
 * Lista de contas que podem atender um subgrupo do Gateway. Recebe o rótulo
 * cru do subgrupo (ex.: "Gemini", "GPT (OpenAI)") e devolve as contas filtradas.
 * Retorna [] pra qualquer subgrupo sem mapeamento conhecido.
 */
export function accountsForFamily(
  accounts: GatewayAccount[],
  familyLabel: string,
): GatewayAccount[] {
  const providers = FAMILY_TO_PROVIDERS[familyLabel];
  if (!providers || !providers.length) return [];
  return accounts.filter((a) => providers.includes(a.provider));
}

/**
 * Snippet curto pro rótulo: "2 contas: Pessoal, Trabalho". Trunca em N contas
 * pra não estourar o cabeçalho. Sem contas, devolve "".
 */
export function accountsLabelSnippet(accounts: GatewayAccount[], max = 3): string {
  if (!accounts.length) return "";
  const names = accounts.map(accountFriendlyName);
  const shown = names.slice(0, max).join(", ");
  const extra = names.length - max;
  const head = accounts.length === 1 ? "1 conta" : `${accounts.length} contas`;
  return extra > 0 ? `${head}: ${shown} +${extra}` : `${head}: ${shown}`;
}
