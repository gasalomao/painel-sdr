"use client";

import {
  useGatewayAccounts,
  accountsForFamily,
  accountsLabelSnippet,
} from "@/hooks/use-gateway-accounts";
import { groupModels, isFreeModel, type GroupableModel } from "@/lib/model-grouping";
import { SelectGroup, SelectLabel, SelectItem } from "@/components/ui/select";

export const PROVIDER_LABEL: Record<string, string> = {
  nvidia: "NVIDIA NIM",
  combo: "⚡ Combos Virtuais (Resilientes)",
  gateway: "Gateway (Assinatura)",
  openrouter: "OpenRouter",
  gemini: "Google Gemini",
};

export function formatModelLabel(m: GroupableModel, markNoTools = false): string {
  const raw = m.rawId || m.id;
  let label = m.name && m.name !== raw ? `${raw} — ${m.name}` : raw;
  if (m.provider === "nvidia" && m.isFreeEndpoint) {
    label = `★ [FREE ENDPOINT] ${label}`;
  } else if (m.provider === "nvidia" && /nemotron/i.test(raw)) {
    label = `⚡ ${label}`;
  } else if (isFreeModel(m)) {
    label = `★ [GRÁTIS] ${label}`;
  }
  if (markNoTools && m.supportsTools === false) label += " ⚠ sem ferramentas";
  return label;
}

export function formatSubGroupTitle(provider: string, subLabel: string, accounts: any[] = []): string {
  const familyAccounts = provider === "gateway"
    ? accountsForFamily(accounts, subLabel)
    : [];
  const apelidosTag = familyAccounts.length
    ? ` — ${accountsLabelSnippet(familyAccounts)}`
    : "";
  let subTag = subLabel;
  if (subLabel) {
    if (subLabel === "Grátis" || subLabel.startsWith("Grátis")) {
      subTag = `★ ${subLabel}`;
    } else if (subLabel === "Nemotron (NVIDIA)") {
      subTag = `⚡ ${subLabel}`;
    }
  }
  return `${PROVIDER_LABEL[provider] || provider}${subTag ? " · " + subTag : ""}${apelidosTag}`;
}

/**
 * Renderiza <optgroup>/<option> agrupados por provedor + subgrupo (Grátis,
 * família) pra usar dentro de um <select> NATIVO. Centraliza o agrupamento dos
 * seletores inline das páginas, pra todos ficarem organizados igual ao dropdown.
 */
export function ModelOptions({ models, markNoTools = false }: { models: GroupableModel[]; markNoTools?: boolean }) {
  const groups = groupModels(models);
  const accounts = useGatewayAccounts();
  return (
    <>
      {groups.map(group =>
        group.subgroups.map(sub => {
          const groupTitle = formatSubGroupTitle(group.provider, sub.label, accounts);
          return (
            <optgroup
              key={group.provider + "|" + (sub.label || "_")}
              label={groupTitle}
              className="bg-neutral-900"
            >
              {sub.items.map(m => {
                const label = formatModelLabel(m, markNoTools);
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

/**
 * Renderiza <SelectGroup>/<SelectLabel>/<SelectItem> agrupados para usar dentro de
 * um Radix/Base-UI <SelectContent>.
 */
export function RadixModelOptions({ models, markNoTools = false }: { models: GroupableModel[]; markNoTools?: boolean }) {
  const groups = groupModels(models);
  const accounts = useGatewayAccounts();
  return (
    <>
      {groups.map(group =>
        group.subgroups.map(sub => {
          const groupTitle = formatSubGroupTitle(group.provider, sub.label, accounts);
          return (
            <SelectGroup key={group.provider + "|" + (sub.label || "_")}>
              <SelectLabel className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground px-2 py-1">
                {groupTitle}
              </SelectLabel>
              {sub.items.map(m => {
                const label = formatModelLabel(m, markNoTools);
                return (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {label}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          );
        })
      )}
    </>
  );
}
