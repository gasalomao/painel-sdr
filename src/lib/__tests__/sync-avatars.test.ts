/**
 * Testes para Sincronização Otimizada e Escalável de Fotos de Perfil (Avatares)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/contacts/sync-avatars/route";
import { bulkSyncProfilePics, invalidateChannelCache } from "../channel";
import { requireClientId } from "@/lib/tenant";

const { mockContactsUpsert, mockSupabase } = vi.hoisted(() => {
  const mockContactsUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "channel_connections") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { instance_name: "inst-1", status: "connected", provider: "evolution", client_id: "client-123", provider_config: {} } }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        upsert: mockContactsUpsert,
      };
    }),
  };
  return { mockContactsUpsert, mockSupabase };
});

vi.mock("@/lib/supabase", () => ({
  supabase: mockSupabase,
  supabaseAdmin: mockSupabase,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: mockSupabase,
  supabase: mockSupabase,
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {},
  getEvolutionConfig: async () => ({ url: "https://evo.test", apiKey: "test-key", instance: "inst-1" }),
}));
vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn().mockResolvedValue({ ok: true, clientId: "client-123" }),
}));

afterEach(() => vi.unstubAllGlobals());

function syncRequest(): NextRequest {
  return new NextRequest("http://localhost/api/contacts/sync-avatars", {
    method: "POST", body: JSON.stringify({ instance: "inst-1", scope: "contacts" }),
  });
}

describe("bulkSyncProfilePics — escalabilidade e sincronização em lote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireClientId).mockResolvedValue({ ok: true, clientId: "client-123", isAdmin: false, impersonating: false, claims: {} as never });
    mockContactsUpsert.mockReset().mockResolvedValue({ error: null });
    invalidateChannelCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "5511999990001@s.whatsapp.net", profilePictureUrl: "https://pps.whatsapp.net/v/t61/1.jpg" },
        { id: "5511999990002@s.whatsapp.net", profilePictureUrl: "https://pps.whatsapp.net/v/t61/2.jpg" },
        { id: "5511999990003@s.whatsapp.net", profilePictureUrl: null }, // sem foto
      ],
    }));
  });

  it("mantém o retorno tolerante legado em falha de rede", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    await expect(bulkSyncProfilePics("inst-1")).resolves.toBe(0);
    expect(mockContactsUpsert).not.toHaveBeenCalled();
  });

  it.each([
    { name: "rede", failure: new TypeError("fetch failed") },
    { name: "HTTP 503", response: new Response("unavailable", { status: 503 }) },
    { name: "HTTP 200 com falha", response: Response.json({ success: false, error: "upstream error" }) },
    { name: "HTTP 200 com erro e lista", response: Response.json({ error: "upstream error", data: [] }) },
    { name: "HTTP 200 parcial", response: Response.json({ success: true, partial: true, failed: 1, data: [] }) },
    { name: "HTTP 200 malformado", response: Response.json({ message: "Internal error" }) },
    { name: "HTTP 200 JSON inválido", response: new Response("<html>error</html>") },
  ])("API contacts não anuncia sucesso para $name", async ({ failure, response }) => {
    if (failure) vi.mocked(fetch).mockRejectedValue(failure);
    else vi.mocked(fetch).mockResolvedValue(response!);
    const result = await POST(syncRequest());
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ success: false, error: expect.any(String) });
    expect(mockContactsUpsert).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ body: [] }, { body: { data: [] } }])("API contacts distingue lista vazia de falha $body", async ({ body }) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    const result = await POST(syncRequest());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ success: true, updated: 0 });
  });

  it.each(["resposta com erro", "rejeição de rede"])("API contacts não anuncia sucesso quando persistência parcial tem %s", async (failure) => {
    mockContactsUpsert.mockResolvedValueOnce({ error: null });
    if (failure === "resposta com erro") mockContactsUpsert.mockResolvedValueOnce({ error: { message: "write failed" } });
    else mockContactsUpsert.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await POST(syncRequest());
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ success: false });
    expect(mockContactsUpsert).toHaveBeenCalledTimes(2);
  });

  it("filtra contatos sem foto e atualiza em batch paralelo via upsert com onConflict", async () => {
    const count = await bulkSyncProfilePics("inst-1");
    expect(count).toBe(2);
    expect(mockContactsUpsert).toHaveBeenCalledTimes(2);
    expect(mockContactsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "client-123" }),
      { onConflict: "client_id,remote_jid" },
    );
  });
});





