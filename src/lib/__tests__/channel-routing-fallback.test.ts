import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    mockMaybeSingle: vi.fn(),
    mockGoSendText: vi.fn(),
    mockGoSendMedia: vi.fn(),
    mockGoGetStatus: vi.fn(),
    mockGoCheckDetailed: vi.fn(),
    mockGoFetchPic: vi.fn(),
    mockV2SendText: vi.fn(),
    mockV2SendMedia: vi.fn(),
    mockV2GetStatus: vi.fn(),
    mockV2CheckDetailed: vi.fn(),
    mockV2FetchPic: vi.fn(),
    mockCloudSendText: vi.fn(),
    mockCloudSendMedia: vi.fn(),
  };
});

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mocks.mockMaybeSingle,
        }),
      }),
    }),
  },
}));

vi.mock("../providers/evolution-go", () => ({
  evolutionGo: {
    name: "evolution_go",
    sendText: mocks.mockGoSendText,
    sendMedia: mocks.mockGoSendMedia,
    getStatus: mocks.mockGoGetStatus,
    checkNumbersDetailed: mocks.mockGoCheckDetailed,
    fetchProfilePicture: mocks.mockGoFetchPic,
  },
}));

vi.mock("../providers/evolution-v2", () => ({
  evolutionV2: {
    name: "evolution",
    sendText: mocks.mockV2SendText,
    sendMedia: mocks.mockV2SendMedia,
    getStatus: mocks.mockV2GetStatus,
    checkNumbersDetailed: mocks.mockV2CheckDetailed,
    fetchProfilePicture: mocks.mockV2FetchPic,
  },
}));

vi.mock("../whatsapp-cloud", () => ({
  whatsappCloud: {
    sendText: mocks.mockCloudSendText,
    sendMedia: mocks.mockCloudSendMedia,
  },
}));

import {
  resolveChannel,
  invalidateChannelCache,
  sendMessage,
  sendMedia,
  getStatus,
  fetchProfilePicture,
  checkNumbersDetailed,
} from "../channel";

describe("channel routing and fallback tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateChannelCache();
  });

  describe("resolveChannel", () => {
    it("should resolve provider and cache it", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: {
          instance_name: "inst_1",
          provider: "evolution_go",
          agent_id: 2,
          status: "connected",
        },
      });

      const res1 = await resolveChannel("inst_1");
      expect(res1.provider).toBe("evolution_go");
      expect(res1.agent_id).toBe(2);

      // Second call should hits cache and not query DB again
      const res2 = await resolveChannel("inst_1");
      expect(res2.provider).toBe("evolution_go");
      expect(mocks.mockMaybeSingle).toHaveBeenCalledTimes(1);
    });

    it("should bypass cache if fresh option is true", async () => {
      mocks.mockMaybeSingle.mockResolvedValue({
        data: {
          instance_name: "inst_1",
          provider: "evolution_go",
        },
      });

      await resolveChannel("inst_1");
      await resolveChannel("inst_1", { fresh: true });
      expect(mocks.mockMaybeSingle).toHaveBeenCalledTimes(2);
    });

    it("should resolve whatsapp_cloud config", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: {
          instance_name: "inst_cloud",
          provider: "whatsapp_cloud",
          provider_config: {
            phone_number_id: "12345",
            access_token: "token_abc",
          },
        },
      });

      const res = await resolveChannel("inst_cloud");
      expect(res.provider).toBe("whatsapp_cloud");
      expect(res.cloud?.phone_number_id).toBe("12345");
      expect(res.cloud?.access_token).toBe("token_abc");
    });
  });

  describe("sendMessage", () => {
    it("should route to primary (evolutionGo) if connection provider is evolution_go", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "go_inst", provider: "evolution_go" },
      });
      mocks.mockGoSendText.mockResolvedValueOnce({ ok: true, messageId: "msg_go" });

      const res = await sendMessage("551199999999", "Hello", "go_inst");
      expect(res.ok).toBe(true);
      expect(res.messageId).toBe("msg_go");
      expect(mocks.mockGoSendText).toHaveBeenCalledWith("551199999999", "Hello", "go_inst");
      expect(mocks.mockV2SendText).not.toHaveBeenCalled();
    });

    it("should fallback to secondary (evolutionV2) if evolutionGo fails", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "go_inst", provider: "evolution_go" },
      });
      mocks.mockGoSendText.mockResolvedValueOnce({ ok: false, error: "GO down" });
      mocks.mockV2SendText.mockResolvedValueOnce({ ok: true, messageId: "msg_v2" });

      const res = await sendMessage("551199999999", "Hello", "go_inst");
      expect(res.ok).toBe(true);
      expect(res.messageId).toBe("msg_v2");
      expect(mocks.mockGoSendText).toHaveBeenCalledTimes(1);
      expect(mocks.mockV2SendText).toHaveBeenCalledWith("551199999999", "Hello", "go_inst");
    });

    it("should route to primary (evolutionV2) if connection provider is evolution", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "v2_inst", provider: "evolution" },
      });
      mocks.mockV2SendText.mockResolvedValueOnce({ ok: true, messageId: "msg_v2" });

      const res = await sendMessage("551199999999", "Hello", "v2_inst");
      expect(res.ok).toBe(true);
      expect(mocks.mockV2SendText).toHaveBeenCalledWith("551199999999", "Hello", "v2_inst");
      expect(mocks.mockGoSendText).not.toHaveBeenCalled();
    });

    it("should fallback to secondary (evolutionGo) if evolutionV2 fails", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "v2_inst", provider: "evolution" },
      });
      mocks.mockV2SendText.mockResolvedValueOnce({ ok: false, error: "V2 error" });
      mocks.mockGoSendText.mockResolvedValueOnce({ ok: true, messageId: "msg_go" });

      const res = await sendMessage("551199999999", "Hello", "v2_inst");
      expect(res.ok).toBe(true);
      expect(mocks.mockV2SendText).toHaveBeenCalledTimes(1);
      expect(mocks.mockGoSendText).toHaveBeenCalledWith("551199999999", "Hello", "v2_inst");
    });

    it("should route directly to whatsapp_cloud with no fallback on error", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: {
          instance_name: "cloud_inst",
          provider: "whatsapp_cloud",
          provider_config: { phone_number_id: "1", access_token: "t" },
        },
      });
      mocks.mockCloudSendText.mockRejectedValueOnce(new Error("Cloud API Error"));

      await expect(sendMessage("551199999999", "Hello", "cloud_inst")).rejects.toThrow("Cloud API Error");
      expect(mocks.mockCloudSendText).toHaveBeenCalledTimes(1);
      expect(mocks.mockGoSendText).not.toHaveBeenCalled();
      expect(mocks.mockV2SendText).not.toHaveBeenCalled();
    });
  });

  describe("sendMedia", () => {
    const dummyMedia = {
      type: "image" as const,
      base64: "a".repeat(150),
      fileName: "test.jpg",
      mimetype: "image/jpeg",
    };

    it("should route and convert media with fallback for evolution_go", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "go_inst", provider: "evolution_go" },
      });
      mocks.mockGoSendMedia.mockResolvedValueOnce({ ok: false, error: "GO fails" });
      mocks.mockV2SendMedia.mockResolvedValueOnce({ ok: true, messageId: "media_v2" });

      const res = await sendMedia("551199999999", "caption text", dummyMedia, "go_inst");
      expect(res.ok).toBe(true);
      expect(res.messageId).toBe("media_v2");
      expect(mocks.mockGoSendMedia).toHaveBeenCalledTimes(1);
      expect(mocks.mockV2SendMedia).toHaveBeenCalledTimes(1);
    });

    it("should route directly to whatsapp_cloud sendMedia", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: {
          instance_name: "cloud_inst",
          provider: "whatsapp_cloud",
          provider_config: { phone_number_id: "1", access_token: "t" },
        },
      });
      mocks.mockCloudSendMedia.mockResolvedValueOnce({ ok: true, messageId: "media_cloud" });

      const res = await sendMedia("551199999999", "caption text", dummyMedia, "cloud_inst");
      expect(res.ok).toBe(true);
      expect(res.messageId).toBe("media_cloud");
      expect(mocks.mockCloudSendMedia).toHaveBeenCalledTimes(1);
    });
  });

  describe("other routes (getStatus, fetchProfilePicture, checkNumbersDetailed)", () => {
    it("getStatus fallbacks correctly", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "go_inst", provider: "evolution_go" },
      });
      mocks.mockGoGetStatus.mockResolvedValueOnce({ state: "unknown" });
      mocks.mockV2GetStatus.mockResolvedValueOnce({ state: "open" });

      const res = await getStatus("go_inst");
      expect(res.state).toBe("open");
    });

    it("fetchProfilePicture fallbacks correctly", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "v2_inst", provider: "evolution" },
      });
      mocks.mockV2FetchPic.mockResolvedValueOnce(null);
      mocks.mockGoFetchPic.mockResolvedValueOnce("http://pic.url");

      const res = await fetchProfilePicture("551199999999", "v2_inst");
      expect(res).toBe("http://pic.url");
    });

    it("checkNumbersDetailed fallbacks correctly", async () => {
      mocks.mockMaybeSingle.mockResolvedValueOnce({
        data: { instance_name: "go_inst", provider: "evolution_go" },
      });
      mocks.mockGoCheckDetailed.mockResolvedValueOnce({});
      mocks.mockV2CheckDetailed.mockResolvedValueOnce({ "55119": { exists: true, jid: "55119@s.whatsapp.net" } });

      const res = await checkNumbersDetailed(["55119"], "go_inst");
      expect(res["55119"].exists).toBe(true);
    });
  });
});
