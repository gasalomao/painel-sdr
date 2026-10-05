import type { WebsiteAsset } from "./types";

export function requestsWebsiteLogo(prompt: string): boolean {
  return /\b(?:logo|logotipo|logomarca)\b/i.test(prompt)
    && /\b(?:use|usar|utilize|utilizar|coloque|colocar|insira|inserir|adicione|adicionar|aplique|aplicar|substitua|substituir|troque|trocar)\b/i.test(prompt)
    && !/\b(?:n[aã]o|sem|remova|remover|retire|retirar|apague|exclua)\b/i.test(prompt);
}

export function resolveWebsiteUploadPurpose(item: { purpose?: WebsiteAsset["purpose"]; purposeExplicit?: boolean }, prompt: string, count: number): WebsiteAsset["purpose"] {
  return !item.purposeExplicit && count === 1 && requestsWebsiteLogo(prompt) ? "logo" : item.purpose ?? "content";
}
