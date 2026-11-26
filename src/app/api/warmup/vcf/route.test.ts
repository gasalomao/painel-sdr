// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  ensure: vi.fn(),
  readConfigs: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.auth,
}));

vi.mock("@/lib/warmup/warmup-config-service", () => ({
  ensureWarmupConfigsForTenant: mocks.ensure,
  readTenantWarmupConfigs: mocks.readConfigs,
}));

import { GET } from "./route";

describe("GET /api/warmup/vcf", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({
      ok: true,
      clientId: "tenant-vcf",
      isAdmin: true,
      impersonating: false,
      claims: { features: { aquecer_chips: true } },
    });
    mocks.ensure.mockReset();
    mocks.readConfigs.mockReset();
  });

  it("gera arquivo .vcf vCard 3.0 válido e deduplicado para os chips do tenant", async () => {
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [
        { instance_name: "chip_sp_1", status: "open", phone_number: "5511961607625" },
        { instance_name: "chip_ba_2", status: "open", phone_number: "557391810230" },
        { instance_name: "chip_dup_9dig", status: "open", phone_number: "551161607625" },
      ],
    });
    mocks.readConfigs.mockResolvedValue({
      source: "table",
      configs: {
        chip_sp_1: { phone_number: "5511961607625" },
        chip_ba_2: { phone_number: "557391810230" },
        chip_dup_9dig: { phone_number: "551161607625" },
      },
    });

    const req = new NextRequest("http://localhost/api/warmup/vcf");
    const res = await GET(req);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/vcard");
    expect(res.headers.get("content-disposition")).toContain("agenda-chips-colmeia.vcf");

    const cards = body.match(/BEGIN:VCARD/g) || [];
    expect(cards).toHaveLength(2);
    expect(body).toContain("FN:chip_sp_1");
    expect(body).toContain("TEL;TYPE=CELL:+5511961607625");
    expect(body).toContain("FN:chip_ba_2");
    expect(body).toContain("TEL;TYPE=CELL:+557391810230");
  });

  it("bloqueia com 403 quando conta não é administradora", async () => {
    mocks.auth.mockResolvedValue({
      ok: true,
      clientId: "tenant-vcf",
      isAdmin: false,
      impersonating: false,
      claims: { features: { aquecer_chips: true } },
    });

    const req = new NextRequest("http://localhost/api/warmup/vcf");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("retorna 404 quando nenhum chip tem telefone resolvido", async () => {
    mocks.ensure.mockResolvedValue({
      created: [],
      enabledNew: [],
      source: "table",
      connections: [{ instance_name: "chip_sem_num", status: "connecting", phone_number: null }],
    });
    mocks.readConfigs.mockResolvedValue({ source: "table", configs: {} });

    const req = new NextRequest("http://localhost/api/warmup/vcf");
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});
