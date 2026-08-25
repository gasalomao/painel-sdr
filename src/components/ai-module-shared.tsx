"use client";

import { cn } from "@/lib/utils";
import {
  useGatewayAccounts,
  accountsForFamily,
  accountsLabelSnippet,
  accountFriendlyName,
} from "@/hooks/use-gateway-accounts";
import { groupModels, type GroupableModel } from "@/lib/model-grouping";

const PROVIDER_LABEL: Record<string, string> = {
  combo: "⚡ Combos Virtuais (Resilientes)",
  gateway: "Gateway (Assinatura)",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
};

// Cor do cabeçalho de cada grupo de provedor no dropdown.
const PROVIDER_COLOR: Record<string, string> = {
  combo: "text-amber-400 font-bold",
  gateway: "text-emerald-400",
  openrouter: "text-purple-400",
  gemini: "text-blue-400",
};

/**
 * Renderiza <optgroup>/<option> agrupados por provedor + subgrupo (Grátis,
 * família) pra usar dentro de um <select> NATIVO. Centraliza o agrupamento dos
 * seletores inline das páginas, pra todos ficarem organizados igual ao dropdown.
 */
export function ModelOptions({ models, markNoTools = false }: { models: GroupableModel[]; markNoTools?: boolean }) {
  const groups = groupModels(models);
  // Apelidos das contas conectadas ao conector local — só usado pra rotular os
  // subgrupos do Gateway. Vazio pra não-admin (a API responde 403 e o hook só
  // retorna []), e nesse caso o seletor renderiza igual a antes.
  const accounts = useGatewayAccounts();
  return (
    <>
      {groups.map(group =>
        group.subgroups.map(sub => {
          const familyAccounts = group.provider === "gateway"
            ? accountsForFamily(accounts, sub.label)
            : [];
          const apelidosTag = familyAccounts.length
            ? ` — ${accountsLabelSnippet(familyAccounts)}`
            : "";
          return (
          <optgroup
            key={group.provider + "|" + (sub.label || "_")}
            label={`${PROVIDER_LABEL[group.provider] || group.provider}${sub.label ? " · " + (sub.label === "Grátis" ? "★ Grátis" : sub.label) : ""}${apelidosTag}`}
            className="bg-neutral-900"
          >
            {sub.items.map(m => {
              const raw = m.rawId || m.id;
              let label = m.name && m.name !== raw ? `${raw} — ${m.name}` : raw;
              if (markNoTools && m.supportsTools === false) label += " ⚠ sem ferramentas";
              return (
                <option key={m.id} value={m.id} className="bg-neutral-900 text-white">
                  {label}
                </option>
              );
            })}
          </optgroup>
          );
        })
      )}
    </>
  );
}
