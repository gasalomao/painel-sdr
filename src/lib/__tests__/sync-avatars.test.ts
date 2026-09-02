/**
 * Testes para Sincronização Otimizada e Escalável de Fotos de Perfil (Avatares)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bulkSyncProfilePics, invalidateChannelCache } from "../channel";

const { mockContactsUpsert, mockSupabase } = vi.hoisted(() => {
  const mockContactsUpsert = vi.fn().mockResolvedValue({ error: null });
  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "channel_connections") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { provider: "evolution", client_id: "client-123", provider_config: {} } }),
            }),
          }),
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

describe("bulkSyncProfilePics — escalabilidade e sincronização em lote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateChannelCache();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "5511999990001@s.whatsapp.net", profilePictureUrl: "https://pps.whatsapp.net/v/t61/1.jpg" },
        { id: "5511999990002@s.whatsapp.net", profilePictureUrl: "https://pps.whatsapp.net/v/t61/2.jpg" },
        { id: "5511999990003@s.whatsapp.net", profilePictureUrl: null }, // sem foto
      ],
    } as any);
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





