/** Funções de formatação compartilhadas entre a página de tokens e os componentes de gráfico. */

export function formatBRL(c: number) {
  if (!isFinite(c) || c === 0) return "R$ 0,00";
  return c.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: c < 0.1 ? 4 : 2,
  });
}

export function formatUSD(c: number) {
  if (!isFinite(c)) return "$0.00";
  if (c === 0) return "$0.00";
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}

export function formatTokens(n: number) {
  if (!isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function formatPctMoney(part: number, total: number) {
  if (!total) return "0%";
  return ((part / total) * 100).toFixed(part / total < 0.05 ? 1 : 0) + "%";
}

export const SOURCE_META: Record<
  string,
  { label: string; color: string; icon: any; gradient: string }
> = {
  agent: {
    label: "Agente IA",
    color: "#22d3ee",
    icon: () => null,
    gradient: "from-cyan-500/20 to-cyan-500/0",
  },
  disparo: {
    label: "Disparo em Massa",
    color: "#f59e0b",
    icon: () => null,
    gradient: "from-amber-500/20 to-amber-500/0",
  },
  followup: {
    label: "Follow-up",
    color: "#a78bfa",
    icon: () => null,
    gradient: "from-violet-500/20 to-violet-500/0",
  },
  organizer: {
    label: "Organizador IA",
    color: "#34d399",
    icon: () => null,
    gradient: "from-emerald-500/20 to-emerald-500/0",
  },
  other: {
    label: "Outros (mídia)",
    color: "#94a3b8",
    icon: () => null,
    gradient: "from-slate-500/20 to-slate-500/0",
  },
};
