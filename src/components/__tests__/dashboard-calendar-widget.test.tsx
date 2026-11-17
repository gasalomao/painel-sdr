import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DashboardCalendarWidget } from "../dashboard-calendar-widget";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: mocks.from } }));
vi.mock("@/lib/use-session", () => ({
  useClientSession: () => ({
    session: { clientId: "tenant-a", isAdmin: false, impersonating: false, features: { calendario: true } },
    loading: false,
  }),
}));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.from.mockClear();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DashboardCalendarWidget BFF", () => {
  it("carrega agendamentos via GET /api/appointments sem usar cliente direto no browser", async () => {
    const todayIso = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          appointments: [
            { id: "a1", title: "Reunião Confirmada", start_at: todayIso, end_at: todayIso, status: "confirmed", remote_jid: "5511999990000@s.whatsapp.net" },
            { id: "a2", title: "Reunião Cancelada", start_at: todayIso, end_at: todayIso, status: "cancelled", remote_jid: "5511999990000@s.whatsapp.net" },
          ],
        }),
        { status: 200 },
      ),
    );

    render(<DashboardCalendarWidget />);

    expect(await screen.findByText("Reunião Confirmada")).toBeInTheDocument();
    expect(screen.queryByText("Reunião Cancelada")).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/appointments?"), expect.anything());
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

