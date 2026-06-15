/**
 * Helper SaaS-safe: sobrescreve campos de "modelo IA" do body da request
 * quando o solicitante NÃO é admin não-impersonando.
 *
 * Motivo: cliente comum não escolhe modelo (controle de custo). Mesmo que
 * a UI esconda o select, alguém pode forjar POST/PATCH direto. Esta camada
 * blinda no backend — única fonte da verdade pra cliente comum é
 * `clients.default_ai_model` (ou o default global do organizer se vazio).
 *
 * Uso típico nas rotas POST/PATCH de campaigns / followup / automations:
 *
 *    const auth = await requireClientId(req);
 *    if (!auth.ok) return auth.response;
 *    const body = await req.json();
 *    await enforceClientDefaultModel(body, auth, [
 *      "ai_model",
 *      "dispatch_ai_model",
 *      "followup_ai_model",
 *    ]);
 *    // ... segue com body normalmente. Os campos foram sobrescritos
 *    // pelo modelo do cliente caso o caller não seja admin.
 */

import { resolveModelForClient } from "@/lib/ai-default-model";

/** Forma mínima que aceitamos pro caller — bate com tanto requireClientId
 *  quanto verifySession. Só lemos clientId + isAdmin + impersonating. */
type AuthLike = {
  clientId: string;
  isAdmin?: boolean;
  impersonating?: boolean;
};

/**
 * MUTA o body — sobrescreve cada campo listado pelo modelo padrão do cliente
 * SE o caller não for admin. Para admin, deixa o body como veio (admin pode
 * escolher qualquer modelo).
 *
 * Idempotente — chamar 2x não tem efeito colateral.
 */
export async function enforceClientDefaultModel(
  body: Record<string, any>,
  auth: AuthLike,
  fields: string[],
): Promise<void> {
  // Admin não-impersonando: livre pra trocar modelo. Quando impersonando
  // um cliente, tem que respeitar o limite do cliente (consistência total).
  const isRealAdmin = !!auth.isAdmin && !auth.impersonating;
  if (isRealAdmin) return;
  const effectiveModel = await resolveModelForClient(auth.clientId);
  // Se NEM modelo default tem, preserva o body mas é responsabilidade do
  // caller decidir o que fazer (provavelmente erro 400 em outro lugar).
  if (!effectiveModel) return;
  for (const f of fields) {
    // Só sobrescreve se o body tem a chave (não cria do nada). Cliente
    // pediu modelo X → body.ai_model = X → trocamos pelo default. Cliente
    // não pediu nada → body sem a key → não tocamos.
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      body[f] = effectiveModel;
    }
  }
}
