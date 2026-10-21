import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PhotoError,
  resolvePhotoConnection,
  readPhotoCache,
  refreshPhotos,
  type PhotoConnection,
} from "../whatsapp-photos";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { fetchProfilePicture } from "@/lib/channel";

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}));

vi.mock("@/lib/channel", () => ({
  fetchProfilePicture: vi.fn(),
}));

const CLIENT_ID = "tenant-test-1";
const INSTANCE = "inst-test-1";
const JID = "5511999990001@s.whatsapp.net";
const JID_2 = "5511999990002@s.whatsapp.net";
const ALIAS_JID = "551199990001@s.whatsapp.net";
const VALID_PHOTO = "https://pps.whatsapp.net/v/avatar1.jpg";
const NEW_PHOTO = "https://pps.whatsapp.net/v/avatar2.jpg";

describe("whatsapp-photos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PhotoError", () => {
    it("instantiates correctly with message and status", () => {
      const err = new PhotoError("Forbidden", 403);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(PhotoError);
      expect(err.message).toBe("Forbidden");
      expect(err.status).toBe(403);
      expect(err.name).toBe("PhotoError");
    });
  });

  describe("resolvePhotoConnection", () => {
    it("queries channel_connections scoped to tenant clientId", async () => {
      const mockEq = vi.fn().mockReturnThis();
      const mockOrder = vi.fn().mockReturnThis();
      const mockLimit = vi.fn().mockReturnThis();
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: {
          instance_name: INSTANCE,
          client_id: CLIENT_ID,
          provider: "evolution",
          status: "open",
          provider_config: {},
        },
        error: null,
      });

      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: mockEq,
        order: mockOrder,
        limit: mockLimit,
        maybeSingle: mockMaybeSingle,
      } as any);

      const conn = await resolvePhotoConnection(CLIENT_ID, INSTANCE);
      expect(conn.instance_name).toBe(INSTANCE);
      expect(conn.client_id).toBe(CLIENT_ID);
      expect(conn.provider).toBe("evolution");
      expect(conn.status).toBe("open");
      expect(mockEq).toHaveBeenCalledWith("client_id", CLIENT_ID);
      expect(mockEq).toHaveBeenCalledWith("instance_name", INSTANCE);
    });

    it("seleciona conexão ativa suportada em vez da conexão mais recente desconectada", async () => {
      const query = {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { instance_name: INSTANCE, client_id: CLIENT_ID, provider: "evolution", status: "open" }, error: null }),
      };
      vi.mocked(supabaseAdmin.from).mockReturnValue(query as never);
      await resolvePhotoConnection(CLIENT_ID);
      expect(query.in).toHaveBeenCalledWith("status", ["connected", "open"]);
      expect(query.in).toHaveBeenCalledWith("provider", ["evolution", "evolution_v2", "evolution_go"]);
    });

    it("throws 404 when no connection owned by tenant is found", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      } as any);

      await expect(resolvePhotoConnection(CLIENT_ID, "other-instance")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("throws 409 when connection is disconnected", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            instance_name: INSTANCE,
            client_id: CLIENT_ID,
            provider: "evolution",
            status: "disconnected",
          },
          error: null,
        }),
      } as any);

      await expect(resolvePhotoConnection(CLIENT_ID, INSTANCE)).rejects.toMatchObject({
        status: 409,
      });
    });

    it("throws 422 when connection provider is unsupported (e.g. whatsapp_cloud)", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            instance_name: INSTANCE,
            client_id: CLIENT_ID,
            provider: "whatsapp_cloud",
            status: "open",
          },
          error: null,
        }),
      } as any);

      await expect(resolvePhotoConnection(CLIENT_ID, INSTANCE)).rejects.toMatchObject({
        status: 422,
      });
    });

    it("throws 500 when database errors", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "DB failure" },
        }),
      } as any);

      await expect(resolvePhotoConnection(CLIENT_ID, INSTANCE)).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe("readPhotoCache", () => {
    it("returns empty Map immediately without DB query when jids is empty", async () => {
      const res = await readPhotoCache(CLIENT_ID, []);
      expect(res.size).toBe(0);
      expect(supabaseAdmin.from).not.toHaveBeenCalled();
    });

    it("queries contacts table and maps safe photos and timestamps", async () => {
      const now = new Date().toISOString();
      const mockEq = vi.fn().mockReturnThis();
      const mockIn = vi.fn().mockResolvedValue({
        data: [
          {
            remote_jid: JID,
            profile_pic_url: VALID_PHOTO,
            profile_pic_fetched_at: now,
          },
          {
            remote_jid: JID_2,
            profile_pic_url: null,
            profile_pic: "https://pps.whatsapp.net/v/legacy.jpg", // legacy fallback
            profile_pic_fetched_at: null,
          },
        ],
        error: null,
      });

      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: mockEq,
        in: mockIn,
      } as any);

      const res = await readPhotoCache(CLIENT_ID, [JID, JID_2, "5511999990003@s.whatsapp.net"]);
      expect(res.get(JID)?.url).toBe(VALID_PHOTO);
      expect(res.get(JID)?.fetchedAt).toBe(Date.parse(now));
      expect(res.get(JID_2)?.url).toBe("https://pps.whatsapp.net/v/legacy.jpg");
      expect(res.get(JID_2)?.fetchedAt).toBeNull();
      expect(res.get("5511999990003@s.whatsapp.net")?.url).toBeNull();
    });

    it.each([[JID], [JID, ALIAS_JID], [ALIAS_JID, JID]])("prioriza foto exata válida mesmo com variante BR mais recente: %j", async (...jids) => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [
          { remote_jid: JID, profile_pic_url: VALID_PHOTO, profile_pic_fetched_at: "2026-01-01" },
          { remote_jid: ALIAS_JID, profile_pic_url: NEW_PHOTO, profile_pic_fetched_at: "2026-02-01" },
        ], error: null }),
      } as never);
      const cached = await readPhotoCache(CLIENT_ID, jids);
      expect(cached.get(JID)).toEqual({ url: VALID_PHOTO, fetchedAt: Date.parse("2026-01-01") });
      if (jids.includes(ALIAS_JID)) expect(cached.get(ALIAS_JID)?.url).toBe(NEW_PHOTO);
    });

    it("não usa outra identidade explicitamente pedida como fallback de cache", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: ALIAS_JID, profile_pic_url: NEW_PHOTO }], error: null }),
      } as never);
      const cached = await readPhotoCache(CLIENT_ID, [JID, ALIAS_JID]);
      expect(cached.get(JID)?.url).toBeNull();
      expect(cached.get(ALIAS_JID)?.url).toBe(NEW_PHOTO);
    });

    it("hidrata aliases BR/c.us do mesmo tenant e prefere foto válida ao cache negativo exato", async () => {
      const alias = "551199990001@c.us";
      const query = {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [
          { remote_jid: JID, profile_pic_url: null, profile_pic_fetched_at: new Date().toISOString() },
          { remote_jid: alias, profile_pic_url: "https://evil.test/bad", profile_pic: VALID_PHOTO, profile_pic_fetched_at: "2026-01-01" },
        ], error: null }),
      };
      vi.mocked(supabaseAdmin.from).mockReturnValue(query as never);
      const res = await readPhotoCache(CLIENT_ID, [JID]);
      expect(res.get(JID)?.url).toBe(VALID_PHOTO);
      expect(query.in).toHaveBeenCalledWith("remote_jid", expect.arrayContaining([JID, alias]));
      expect(query.eq).toHaveBeenCalledWith("client_id", CLIENT_ID);
    });

    it("hidrata número estrangeiro sem sufixo sem acrescentar DDI brasileiro", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: "14155552671", profile_pic_url: VALID_PHOTO }], error: null }),
      } as never);
      expect((await readPhotoCache(CLIENT_ID, ["14155552671@s.whatsapp.net"])).get("14155552671@s.whatsapp.net")?.url).toBe(VALID_PHOTO);
    });

    it("sanitizes unsafe cached URLs to null", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [
            {
              remote_jid: JID,
              profile_pic_url: "javascript:alert(1)",
              profile_pic_fetched_at: new Date().toISOString(),
            },
          ],
          error: null,
        }),
      } as any);

      const res = await readPhotoCache(CLIENT_ID, [JID]);
      expect(res.get(JID)?.url).toBeNull();
    });

    it("throws PhotoError 500 when DB errors", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "DB read error" },
        }),
      } as any);

      await expect(readPhotoCache(CLIENT_ID, [JID])).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe("refreshPhotos", () => {
    const connection: PhotoConnection = {
      instance_name: INSTANCE,
      client_id: CLIENT_ID,
      provider: "evolution",
      status: "open",
    };

    it("enforces process-local in-flight guard and returns 409 on overlap", async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      // Mock readPhotoCache via DB
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: vi.fn().mockResolvedValue({ error: null }),
      } as any);

      vi.mocked(fetchProfilePicture).mockImplementation(async () => {
        await firstPromise;
        return NEW_PHOTO;
      });

      const p1 = refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      // Second overlapping call for same connection
      const p2 = refreshPhotos(CLIENT_ID, connection, [JID], { force: true });

      await expect(p2).rejects.toMatchObject({ status: 409 });

      resolveFirst!();
      await p1;
    });

    it("limita concorrência a cinco e não grava nem inicia próximos lotes após cancelamento", async () => {
      const controller = new AbortController();
      let release!: (url: string) => void;
      const pending = new Promise<string>((resolve) => { release = resolve; });
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockReturnValue(pending);
      const jids = Array.from({ length: 7 }, (_, index) => `551199999000${index}@s.whatsapp.net`);
      const syncing = refreshPhotos(CLIENT_ID, connection, jids, { force: true, signal: controller.signal });
      await vi.waitFor(() => expect(fetchProfilePicture).toHaveBeenCalledTimes(5));
      controller.abort();
      release(NEW_PHOTO);
      expect(await syncing).toMatchObject({ cancelled: true, skipped: 7, updated: 0, noPhoto: 0, failed: 0 });
      expect(fetchProfilePicture).toHaveBeenCalledTimes(5);
      expect(upsert).not.toHaveBeenCalled();
      expect(await refreshPhotos(CLIENT_ID, connection, [JID], { force: true })).toMatchObject({ updated: 1 });
    });

    it("skips fresh positive cache (< 24h) and negative cache (< 1h) unless force is true", async () => {
      const now = Date.now();
      const freshPositive = new Date(now - 1000 * 60 * 60).toISOString(); // 1h ago (< 24h)
      const freshNegative = new Date(now - 1000 * 60 * 30).toISOString(); // 30min ago (< 1h)

      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [
            { remote_jid: JID, profile_pic_url: VALID_PHOTO, profile_pic_fetched_at: freshPositive },
            { remote_jid: JID_2, profile_pic_url: null, profile_pic_fetched_at: freshNegative },
          ],
          error: null,
        }),
      } as any);

      const res = await refreshPhotos(CLIENT_ID, connection, [JID, JID_2], { force: false });
      expect(res.skipped).toBe(2);
      expect(res.updated).toBe(0);
      expect(res.noPhoto).toBe(0);
      expect(res.avatars[JID]).toBe(VALID_PHOTO);
      expect(res.avatars[JID_2]).toBeNull();
      expect(fetchProfilePicture).not.toHaveBeenCalled();
    });

    it("tenta alias BR sem 9º dígito no provedor estrito e publica a foto nas duas chaves", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockImplementation(async (jid) => jid === JID ? null : NEW_PHOTO);
      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res.updated).toBe(1);
      expect(res.avatars["551199990001@s.whatsapp.net"]).toBe(NEW_PHOTO);
      expect(res.avatars[JID]).toBe(NEW_PHOTO);
      expect(fetchProfilePicture).toHaveBeenNthCalledWith(1, JID, INSTANCE, CLIENT_ID);
      expect(fetchProfilePicture).toHaveBeenNthCalledWith(2, ALIAS_JID, INSTANCE, CLIENT_ID);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ remote_jid: JID, profile_pic_url: NEW_PHOTO }), { onConflict: "client_id,remote_jid" });
    });

    it.each([[JID, ALIAS_JID], [ALIAS_JID, JID]])("renova e grava identidades BR explícitas separadamente: %j", async (...jids) => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [
          { remote_jid: JID, profile_pic_url: VALID_PHOTO, profile_pic_fetched_at: "2026-01-01" },
          { remote_jid: ALIAS_JID, profile_pic_url: NEW_PHOTO, profile_pic_fetched_at: "2026-02-01" },
        ], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockImplementation(async (jid) => jid === JID ? VALID_PHOTO : NEW_PHOTO);
      const result = await refreshPhotos(CLIENT_ID, connection, jids, { force: true });
      expect(result).toMatchObject({ updated: 2, skipped: 0, failed: 0, avatars: { [JID]: VALID_PHOTO, [ALIAS_JID]: NEW_PHOTO } });
      expect(fetchProfilePicture).toHaveBeenCalledTimes(2);
      expect(upsert).toHaveBeenCalledTimes(2);
      for (const [jid, url] of [[JID, VALID_PHOTO], [ALIAS_JID, NEW_PHOTO]]) {
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ client_id: CLIENT_ID, remote_jid: jid, profile_pic_url: url }), { onConflict: "client_id,remote_jid" });
      }
    });

    it("não consulta nem publica variante conflitante do cache mesmo com um único JID pedido", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [
          { remote_jid: JID, profile_pic_url: VALID_PHOTO },
          { remote_jid: ALIAS_JID, profile_pic_url: NEW_PHOTO },
        ], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockImplementation(async (jid) => jid === JID ? null : NEW_PHOTO);
      const result = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(result).toMatchObject({ updated: 0, noPhoto: 1, preserved: 1, avatars: { [JID]: VALID_PHOTO } });
      expect(result.avatars).not.toHaveProperty(ALIAS_JID);
      expect(fetchProfilePicture).toHaveBeenCalledTimes(1);
      expect(upsert).not.toHaveBeenCalled();
    });

    it("não substitui foto exata válida por fallback BR remoto após resposta null", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: JID, profile_pic_url: VALID_PHOTO }], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockImplementation(async (jid) => jid === JID ? null : NEW_PHOTO);
      const result = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(result).toMatchObject({ updated: 0, noPhoto: 1, preserved: 1, avatars: { [JID]: VALID_PHOTO } });
      expect(fetchProfilePicture).toHaveBeenCalledTimes(1);
      expect(upsert).not.toHaveBeenCalled();
    });

    it("não publica atualização exata sobre foto válida da variante conhecida no cache", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: ALIAS_JID, profile_pic_url: VALID_PHOTO }], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockResolvedValue(NEW_PHOTO);
      const result = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(result).toMatchObject({ updated: 1, noPhoto: 0, avatars: { [JID]: NEW_PHOTO } });
      expect(result.avatars).not.toHaveProperty(ALIAS_JID);
      expect(fetchProfilePicture).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ remote_jid: JID, profile_pic_url: NEW_PHOTO }), { onConflict: "client_id,remote_jid" });
    });

    it("ausência/erro de uma identidade explícita não importa a foto da outra", async () => {
      const upsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: ALIAS_JID, profile_pic_url: NEW_PHOTO }], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockImplementation(async (jid) => {
        if (jid === ALIAS_JID) throw new Error("provider unavailable");
        return null;
      });
      const result = await refreshPhotos(CLIENT_ID, connection, [JID, ALIAS_JID], { force: true });
      expect(result).toMatchObject({ updated: 0, noPhoto: 1, failed: 1, skipped: 0, avatars: { [JID]: null, [ALIAS_JID]: NEW_PHOTO } });
      expect(fetchProfilePicture).toHaveBeenCalledTimes(2);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ remote_jid: JID, profile_pic_url: null }), { onConflict: "client_id,remote_jid" });
    });

    it("não transforma URL insegura ou expirada do provedor em ausência confirmada", async () => {
      const upsert = vi.fn();
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }), upsert,
      } as never);
      vi.mocked(fetchProfilePicture).mockResolvedValue("https://pps.whatsapp.net/avatar.jpg?oe=5E0BE100");
      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res).toMatchObject({ failed: 1, noPhoto: 0, updated: 0 });
      expect(upsert).not.toHaveBeenCalled();
    });

    it("conta ausência confirmada mesmo preservando a foto anterior", async () => {
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: JID, profile_pic_url: VALID_PHOTO }], error: null }),
      } as never);
      vi.mocked(fetchProfilePicture).mockResolvedValue(null);
      expect(await refreshPhotos(CLIENT_ID, connection, [JID], { force: true })).toMatchObject({ noPhoto: 1, updated: 0, failed: 0, avatars: { [JID]: VALID_PHOTO } });
    });

    it("persists safe photo URL to DB and increments updated", async () => {
      const mockUpsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: mockUpsert,
      } as any);

      vi.mocked(fetchProfilePicture).mockResolvedValue(NEW_PHOTO);

      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res.updated).toBe(1);
      expect(res.avatars[JID]).toBe(NEW_PHOTO);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: CLIENT_ID,
          remote_jid: JID,
          profile_pic_url: NEW_PHOTO,
        }),
        { onConflict: "client_id,remote_jid" }
      );
    });

    it("persists confirmed no-photo when contact has no existing photo", async () => {
      const mockUpsert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: mockUpsert,
      } as any);

      vi.mocked(fetchProfilePicture).mockResolvedValue(null);

      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res.noPhoto).toBe(1);
      expect(res.avatars[JID]).toBeNull();
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: CLIENT_ID,
          remote_jid: JID,
          profile_pic_url: null,
        }),
        { onConflict: "client_id,remote_jid" }
      );
    });

    it("preserves valid cached photo and does NOT overwrite DB when provider returns null or fails", async () => {
      const mockUpsert = vi.fn();
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({
          data: [{ remote_jid: JID, profile_pic_url: VALID_PHOTO, profile_pic_fetched_at: "2020-01-01" }],
          error: null,
        }),
        upsert: mockUpsert,
      } as any);

      vi.mocked(fetchProfilePicture).mockResolvedValue(null);

      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res.avatars[JID]).toBe(VALID_PHOTO);
      expect(res.updated).toBe(0);
      expect(res.noPhoto).toBe(1);
      expect(res.preserved).toBe(1);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("counts write errors as failed not updated and preserves cached avatar", async () => {
      const mockUpsert = vi.fn().mockResolvedValue({ error: { message: "write error" } });
      vi.mocked(supabaseAdmin.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: mockUpsert,
      } as any);

      vi.mocked(fetchProfilePicture).mockResolvedValue(NEW_PHOTO);

      const res = await refreshPhotos(CLIENT_ID, connection, [JID], { force: true });
      expect(res.failed).toBe(1);
      expect(res.updated).toBe(0);
      expect(res.avatars[JID]).toBeNull();
    });
  });
});
