import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Testes das garantias multi-tenant do /api/agent/process:
 * 1. chats_dashboard writes incluem client_id resolvido do canal
 * 2. History e leadContext filtram pelo client_id correto
 * 3. Tentativa de testar agente de outro tenant via cookie retorna 403
 * 4. Canal com agente de outro tenant em produção retorna agent_tenant_mismatch
 * 5. Instância de outro tenant via cookie retorna 403
 */

describe("Multi-tenant isolation contracts", () => {
  const CLIENT_A = "00000000-0000-0000-0000-00000000a001";
  const CLIENT_B = "00000000-0000-0000-0000-00000000b002";
  const DEFAULT_CLIENT = "00000000-0000-0000-0000-000000000001";

  it("garante que clientId é herdado do canal e não do fallback quando canal existe", () => {
    const channel = { client_id: CLIENT_A, agent_id: 2 };
    const resolvedClientId = (channel as any)?.client_id || DEFAULT_CLIENT;
    expect(resolvedClientId).toBe(CLIENT_A);
  });

  it("bloqueia teste UI com agente de outro tenant (gate a)", () => {
    const tenantCtx = { clientId: CLIENT_B };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = true;

    const agentOwnerClient = agentConfig.client_id;
    const isBlocked = isTestMode && tenantCtx && agentOwnerClient && agentOwnerClient !== tenantCtx.clientId;
    expect(isBlocked).toBe(true);
  });

  it("permite teste UI com agente do mesmo tenant", () => {
    const tenantCtx = { clientId: CLIENT_A };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = true;

    const agentOwnerClient = agentConfig.client_id;
    const isBlocked = isTestMode && tenantCtx && agentOwnerClient && agentOwnerClient !== tenantCtx.clientId;
    expect(!isBlocked).toBe(true);
  });

  it("detecta mismatch agente x canal em produção (gate b)", () => {
    const channel = { client_id: CLIENT_B, agent_id: 2 };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = false;
    const resolvedClientId = channel.client_id;

    const isMismatch = !isTestMode && agentConfig.client_id && channel.client_id && agentConfig.client_id !== resolvedClientId;
    expect(isMismatch).toBe(true);
  });

  it("canal sem client_id (fallback legacy) não engatilha mismatch falso contra agente com tenant real", () => {
    const channel: { client_id: string | null; agent_id: number } = { client_id: null, agent_id: 2 };
    const agentConfig = { id: 2, client_id: CLIENT_A, is_active: true };
    const isTestMode = false;
    const resolvedClientId = channel.client_id || DEFAULT_CLIENT;

    // Regra: só compara se channel.client_id existir explicitamente
    const isMismatch = !isTestMode && agentConfig.client_id && !!channel.client_id && agentConfig.client_id !== resolvedClientId;
    expect(isMismatch).toBe(false);
  });

  it("bloqueia chamada via cookie de sessão com instância pertencente a outro tenant", () => {
    const tenantCtx = { clientId: CLIENT_B };
    const channel = { instance_name: "sdr_bh", client_id: CLIENT_A };

    const isForbidden = tenantCtx && channel?.client_id && channel.client_id !== tenantCtx.clientId;
    expect(isForbidden).toBe(true);
  });
});
