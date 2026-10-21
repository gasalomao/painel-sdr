import { describe, it, expect, vi, beforeEach } from "vitest";
import { evolutionGo, invalidateEvolutionGoCache } from "../providers/evolution-go";
import { evolution, invalidateEvolutionCache } from "../evolution";
import axios from "axios";

vi.mock("axios", () => ({ default: vi.fn() }));
import { bulkSyncProfilePics, fetchProfilePicture, invalidateChannelCache } from "../channel";
import { supabaseAdmin } from "@/lib/supabase_admin";

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}));

describe("whatsapp provider photo security and contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateChannelCache();
    invalidateEvolutionGoCache();
    vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
    vi.stubEnv("EVOLUTION_API_KEY", "test-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    invalidateEvolutionCache();
  });

  describe("Evolution GO fetchProfilePicture", () => {
    it("fails closed (throws) if evo_go_token is missing", async () => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-go-key-123");

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === "app_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          } as any;
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              provider_config: {}, // no evo_go_token
            },
          }),
        } as any;
      });

      await expect(
        evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "test-instance")
      ).rejects.toThrow(/evo_go_token exclusivo/i);
    });

    it("fails closed (throws) if evo_go_token equals the global goKey", async () => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-go-key-123");

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === "app_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          } as any;
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              provider_config: {
                evo_go_token: "global-go-key-123", // equals global key!
              },
            },
          }),
        } as any;
      });

      await expect(
        evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "test-instance")
      ).rejects.toThrow(/evo_go_token exclusivo/i);
    });

    it("uses dedicated per-instance evo_go_token and succeeds on 200 with photo", async () => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-go-key-123");

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === "app_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          } as any;
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              provider_config: {
                evo_go_token: "dedicated-instance-token-456",
              },
            },
          }),
        } as any;
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ pictureUrl: "https://pps.whatsapp.net/v/avatar.jpg" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const photo = await evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "test-instance");
      expect(photo).toBe("https://pps.whatsapp.net/v/avatar.jpg");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://go.test/message/avatar",
        expect.objectContaining({
          headers: expect.objectContaining({
            apikey: "global-go-key-123",
            token: "dedicated-instance-token-456",
          }),
        })
      );
    });

    it("returns null on confirmed absence (e.g. 404 not found or null pictureUrl)", async () => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-go-key-123");

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === "app_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          } as any;
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              provider_config: {
                evo_go_token: "dedicated-instance-token-456",
              },
            },
          }),
        } as any;
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "contact not found" }),
      }));

      const photo = await evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "test-instance");
      expect(photo).toBeNull();
    });

    it.each([
      { ok: false, status: 404, body: { message: "instance not found" } },
      { ok: false, status: 500, body: { message: "contact not found" } },
      { ok: true, status: 200, body: { message: "Internal error" } },
    ])("não cria cache negativo para resposta GO inválida $status", async ({ ok, status, body }) => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global");
      vi.mocked(supabaseAdmin.from).mockImplementation(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [] }),
        maybeSingle: vi.fn().mockResolvedValue({ data: { provider_config: { evo_go_token: "dedicated" } } }),
      }) as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status, json: async () => body }));
      await expect(evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "own")).rejects.toThrow();
    });

    it("throws on auth/network failure (e.g. 401 unauthorized)", async () => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-go-key-123");

      vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
        if (table === "app_settings") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [] }),
          } as any;
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              provider_config: {
                evo_go_token: "dedicated-instance-token-456",
              },
            },
          }),
        } as any;
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      }));

      await expect(
        evolutionGo.fetchProfilePicture("5511999990001@s.whatsapp.net", "test-instance")
      ).rejects.toThrow(/Unauthorized|401/i);
    });
  });

  describe("Evolution v2 fetchProfilePicture", () => {
    it.each([
      { status: 404, data: "<html>nginx not found</html>" },
      { status: 400, data: { message: "Bad Request" } },
      { status: 500, data: { message: "profile not found in upstream" } },
    ])("não confunde falha HTTP $status com ausência de foto", async ({ status, data }) => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
      invalidateEvolutionCache();
      vi.mocked(axios).mockRejectedValue({ response: { status, data } });
      await expect(evolution.fetchProfilePicture("5511999990001@s.whatsapp.net", "own")).rejects.toThrow();
    });

    it("não aceita resposta 200 malformada como ausência confirmada", async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      vi.stubEnv("EVOLUTION_API_URL", "https://evo.test");
      invalidateEvolutionCache();
      vi.mocked(axios).mockResolvedValue({ data: { message: "Internal error" }, headers: {} });
      await expect(evolution.fetchProfilePicture("5511999990001@s.whatsapp.net", "own")).rejects.toThrow();
    });

    it("fails closed (throws) if instance is missing or empty", async () => {
      await expect(
        evolution.fetchProfilePicture("5511999990001@s.whatsapp.net", "")
      ).rejects.toThrow(/instância obrigatória/i);
    });
  });

  describe("channel.bulkSyncProfilePics", () => {
    it.each([
      { name: "rede", failure: new TypeError("fetch failed") },
      { name: "HTTP 401", response: new Response("unauthorized", { status: 401 }) },
      { name: "HTTP 200 parcial", response: Response.json({ contacts: [], partial: true, failed: 1 }) },
      { name: "HTTP 200 inválido", response: Response.json({ message: "Internal error" }) },
    ])("bulk GO strict propaga $name sem fallback v2", async ({ failure, response }) => {
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");
      vi.stubEnv("EVOLUTION_GO_KEY", "global-key");
      vi.mocked(supabaseAdmin.from).mockImplementation(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [] }),
        maybeSingle: vi.fn().mockResolvedValue({ data: {
          instance_name: "go-inst", client_id: "client-a", provider: "evolution_go", status: "connected",
          provider_config: { evo_go_token: "dedicated-token" },
        } }),
      }) as never);
      const fetchMock = failure ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetchMock);
      await expect(bulkSyncProfilePics("go-inst", "client-a", { strict: true })).rejects.toMatchObject({ status: 502 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("https://go.test/message/contacts", expect.objectContaining({
        headers: expect.objectContaining({ token: "dedicated-token" }),
      }));
    });

    it("fails closed on GO if evo_go_token is missing or equals goKey", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            instance_name: "go-inst",
            client_id: "client-a",
            provider: "evolution_go",
            provider_config: { evo_go_token: "same-as-global" },
          },
        }),
      } as any);

      vi.stubEnv("EVOLUTION_GO_KEY", "same-as-global");
      vi.stubEnv("EVOLUTION_GO_URL", "https://go.test");

      const count = await bulkSyncProfilePics("go-inst", "client-a");
      expect(count).toBe(0);
    });

    it("rejects cross-tenant execution when clientId does not match connection", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            instance_name: "v2-inst",
            client_id: "client-b",
            provider: "evolution",
          },
        }),
      } as any);

      const count = await bulkSyncProfilePics("v2-inst", "client-a");
      expect(count).toBe(0);
    });
  });

  describe("channel.fetchProfilePicture strict mode", () => {
    it("não usa fallback de canal global quando leitura da conexão falha", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "DB failure" } }),
      } as never);
      await expect(fetchProfilePicture("5511999990001@s.whatsapp.net", "own", "client-a")).rejects.toThrow();
      expect(axios).not.toHaveBeenCalled();
    });

    it("throws 404 when connection does not belong to clientId", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            instance_name: "v2-inst",
            client_id: "client-b",
            provider: "evolution",
          },
        }),
      } as any);

      await expect(
        fetchProfilePicture("5511999990001@s.whatsapp.net", "v2-inst", "client-a")
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
