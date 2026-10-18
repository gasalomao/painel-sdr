import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/leads/reminders/route";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";

vi.mock("@/lib/tenant", () => ({
  requireClientId: vi.fn(),
}));

describe("GET /api/leads/reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retorna lembretes atrasados e do dia filtrados pelo cliente", async () => {
    const { requireClientId } = await import("@/lib/tenant");
    vi.mocked(requireClientId).mockResolvedValue({
      ok: true,
      clientId: "tenant-abc",
      isAdmin: false,
      impersonating: false,
      claims: {} as any,
    });

    const mockOverdue = [
      { id: "1", nome_negocio: "Oficina A", next_follow_up: "2026-10-17T10:00:00Z" },
    ];
    const mockUpcoming = [
      { id: "2", nome_negocio: "Clinica B", next_follow_up: "2026-10-18T18:00:00Z" },
    ];

    vi.spyOn(supabaseAdmin, "from").mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          not: vi.fn().mockReturnValue({
            lt: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: mockOverdue, error: null }),
              }),
            }),
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: mockUpcoming, error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as any);

    const req = new NextRequest("http://localhost/api/leads/reminders?limit=5");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalOverdue).toBe(1);
    expect(body.totalUpcomingToday).toBe(1);
    expect(body.overdue[0].nome_negocio).toBe("Oficina A");
  });
});
