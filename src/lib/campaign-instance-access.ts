import { isAutoPoolInstance } from "@/lib/campaign-pool";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { isInstanceOwnedByClient } from "@/lib/tenant";

export type InstanceAccessResult =
  | { ok: true }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Valida se o cliente pode usar a instância informada ou o Pool Automático
 * (`__auto_pool__`), garantindo isolamento multi-tenant no servidor.
 */
export async function validateCampaignInstanceAccess(
  clientId: string,
  instanceName: string
): Promise<InstanceAccessResult> {
  if (isAutoPoolInstance(instanceName)) {
    const { count } = await supabase
      .from("channel_connections")
      .select("instance_name", { count: "exact", head: true })
      .eq("client_id", clientId);

    if (!count || count <= 0) {
      return {
        ok: false,
        status: 400,
        error: "Conecte pelo menos uma conta WhatsApp para usar o Pool Automático",
      };
    }
    return { ok: true };
  }

  const owned = await isInstanceOwnedByClient(instanceName, clientId);
  if (!owned) {
    return {
      ok: false,
      status: 403,
      error: "Instância não pertence a este cliente",
    };
  }

  return { ok: true };
}

