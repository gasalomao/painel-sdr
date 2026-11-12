import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrazilPhoneVariants } from "../../jid-utils";
import { isWarmupSend, registerWarmupSend } from "../../manual-send-registry";

const { mockFrom, mockGetStatus } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockGetStatus: vi.fn(),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: mockFrom,
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    getStatus: mockGetStatus,
  },
}));

import {
  detectWarmupPeerTraffic,
  extractCandidatePhones,
  invalidateWarmupFirewallCache,
  matchWarmupPeer,
} from "../warmup-firewall";

describe("extractCandidatePhones & matchWarmupPeer", () => {
  it("ignora JID @lid puro e extrai variantes BR de remoteJidAlt/senderPn", () => {
    const candidates = extractCandidatePhones([
      "123456789012345@lid",
      "5511987654321@s.whatsapp.net",
    ]);

    expect(candidates.has("5511987654321")).toBe(true);
    expect(candidates.has("551187654321")).toBe(true);
    expect(candidates.has("123456789012345")).toBe(false);
  });

  it("bloqueia tráfego cruzado mesmo com diferença de 9º dígito BR e via @lid + remoteJidAlt", () => {
    const peers = [
      {
        instanceName: "00000_DD_11",
        phone: "5511988887777",
        variants: getBrazilPhoneVariants("5511988887777"),
        warmupEnabled: true,
      },
      {
        instanceName: "00000_numero2",
        phone: "551181112222", // cadastrado sem 9º dígito
        variants: getBrazilPhoneVariants("551181112222"),
        warmupEnabled: true,
      },
    ];

    const decision = matchWarmupPeer({
      instanceName: "00000_DD_11",
      remoteJid: "99887766554433@lid",
      remoteJidAlt: "5511981112222@s.whatsapp.net", // evento chegou com 9º dígito
      peers,
    });

    expect(decision).toEqual({
      blocked: true,
      peerInstance: "00000_numero2",
      reason: "warmup_peer_traffic",
    });
  });

  it("não bloqueia chip com aquecimento desligado nem lead externo", () => {
    const peers = [
      {
        instanceName: "00000_DD_11",
        phone: "5511988887777",
        variants: getBrazilPhoneVariants("5511988887777"),
        warmupEnabled: true,
      },
      {
        instanceName: "chip_pausado",
        phone: "5511912345678",
        variants: getBrazilPhoneVariants("5511912345678"),
        warmupEnabled: false,
      },
    ];

    expect(
      matchWarmupPeer({
        instanceName: "00000_DD_11",
        remoteJid: "5511912345678@s.whatsapp.net",
        peers,
      }),
    ).toEqual({ blocked: false });

    expect(
      matchWarmupPeer({
        instanceName: "00000_DD_11",
        remoteJid: "5531999990000@s.whatsapp.net",
        peers,
      }),
    ).toEqual({ blocked: false });
  });
});

describe("detectWarmupPeerTraffic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateWarmupFirewallCache();
  });

  it("bloqueia imediatamente pelo registry de messageId enviado pelo motor de aquecimento", async () => {
    registerWarmupSend("WARMUP_MSG_123");
    expect(isWarmupSend("WARMUP_MSG_123")).toBe(true);

    const decision = await detectWarmupPeerTraffic({
      clientId: "tenant-1",
      instanceName: "00000_DD_11",
      messageId: "WARMUP_MSG_123",
      remoteJid: "5511999998888@s.whatsapp.net",
    });

    expect(decision).toEqual({
      blocked: true,
      reason: "warmup_message_id",
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("faz auto-cura via Evolution getStatus quando phone_number e owner_phone estão null no DB", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "whatsapp_warmup_configs") {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: [
                  { instance_name: "00000_DD_11", phone_number: null, enabled: true },
                  { instance_name: "00000_numero2", phone_number: null, enabled: true },
                ],
              }),
          }),
          update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        };
      }
      if (table === "channel_connections") {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: [
                  { instance_name: "00000_DD_11", provider_config: {} },
                  { instance_name: "00000_numero2", provider_config: {} },
                ],
              }),
          }),
          update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
        };
      }
      if (table === "app_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [] }) }),
      };
    });

    mockGetStatus.mockImplementation(async (inst: string) => {
      if (inst === "00000_DD_11") {
        return { ok: true, data: { instance: { owner: "5511988880001@s.whatsapp.net" } } };
      }
      if (inst === "00000_numero2") {
        return { ok: true, data: { instance: { owner: "5511988880002@s.whatsapp.net" } } };
      }
      return { ok: false };
    });

    const decision = await detectWarmupPeerTraffic({
      clientId: "tenant-null-phones",
      instanceName: "00000_DD_11",
      remoteJid: "5511988880002@s.whatsapp.net",
    });

    expect(decision).toEqual({
      blocked: true,
      peerInstance: "00000_numero2",
      reason: "warmup_peer_traffic",
    });
  });
});

