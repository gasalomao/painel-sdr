import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const state = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  patchSave: vi.fn(),
  update: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "tenant-fixture" }) }));
vi.mock("sonner", () => ({ Toaster: () => <div aria-label="Notificações" />, toast: { error: state.error, success: state.success } }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({ update: state.update }) } }));
import Page from "@/app/follow-up-control/page";

beforeEach(() => {
  state.fetchConfig.mockReset();
  state.patchSave.mockReset();
  state.update.mockReset();
  state.error.mockReset();
  state.success.mockReset();

  state.fetchConfig.mockImplementation(async () =>
    Response.json({ agent: { id: 1, name: "Fixture agent", options: { unrelated: "keep", follow_up: {} } } }),
  );
  state.patchSave.mockImplementation(async (_init?: RequestInit) =>
    Response.json({ success: true, agent: { id: 1, options: { unrelated: "keep", follow_up: {} } } }),
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/agent/settings" && init?.method === "PATCH") {
        return state.patchSave(init);
      }
      if (url === "/api/agent/settings") {
        return Response.json({ agents: [{ id: 1, name: "Fixture agent" }] });
      }
      if (url.startsWith("/api/agent/settings?agent_id=")) {
        return state.fetchConfig(url);
      }
      return Response.json({ success: false });
    }),
  );
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("followup configuration safety", () => {
  it("disables save until configuration is loaded and exposes a scrolling viewport", async () => {
    state.fetchConfig.mockReturnValueOnce(new Promise(() => undefined));
    const { container } = render(<Page />);
    const save = await screen.findByRole("button", { name: "Salvar Configuração" });
    expect(save).toBeDisabled();
    expect(container.firstElementChild?.className).toContain("overflow-y-auto");
  });

  it("never updates options when the server save fails", async () => {
    render(<Page />);
    const save = await screen.findByRole("button", { name: "Salvar Configuração" });
    await waitFor(() => expect(save).not.toBeDisabled());
    state.patchSave.mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 500 }));
    fireEvent.click(save);
    await waitFor(() => expect(state.error).toHaveBeenCalled());
    expect(state.success).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("preserves unrelated options on a confirmed save by scoping PATCH to follow_up", async () => {
    render(<Page />);
    const save = await screen.findByRole("button", { name: "Salvar Configuração" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(state.success).toHaveBeenCalled());
    expect(state.patchSave).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(state.patchSave.mock.calls[0]?.[0]?.body || "{}"));
    expect(body).toEqual({
      agent_id: 1,
      section: "follow_up",
      follow_up: expect.any(Object),
    });
    expect(body.options).toBeUndefined();
    expect(state.update).not.toHaveBeenCalled();
  });
});
