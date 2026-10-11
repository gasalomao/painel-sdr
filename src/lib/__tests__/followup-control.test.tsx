import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const state = vi.hoisted(() => ({ single: vi.fn(), update: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "tenant-fixture" }) }));
vi.mock("sonner", () => ({ Toaster: () => <div aria-label="Notificações" />, toast: { error: state.error, success: state.success } }));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => {
  const chain = { select: () => chain, eq: () => chain, single: state.single, order: async () => ({ data: [{ id: 1, name: "Fixture agent" }], error: null }), update: state.update };
  state.update.mockReturnValue({ eq: () => ({ eq: async () => ({ error: null }) }) });
  return chain;
} } }));
import Page from "@/app/follow-up-control/page";
beforeEach(() => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: false })));
 state.single.mockResolvedValue({ data: { options: { unrelated: "keep", follow_up: {} } }, error: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("followup configuration safety", () => {
 it("disables save until configuration is loaded and exposes a scrolling viewport", async () => {
  state.single.mockReturnValue(new Promise(() => undefined));
  const { container } = render(<Page />);
  const save = await screen.findByRole("button", { name: "Salvar Configuração" });
  expect(save).toBeDisabled();
  expect(container.firstElementChild?.className).toContain("overflow-y-auto");
 });
 it("never updates options when the pre-save read fails", async () => {
  render(<Page />);
  const save = await screen.findByRole("button", { name: "Salvar Configuração" });
  await waitFor(() => expect(save).not.toBeDisabled());
  state.single.mockResolvedValueOnce({ data: null, error: { message: "offline" } });
  fireEvent.click(save);
  await waitFor(() => expect(state.error).toHaveBeenCalled());
  expect(state.update).not.toHaveBeenCalled();
 });
 it("preserves unrelated options on a confirmed save", async () => {
  render(<Page />);
  const save = await screen.findByRole("button", { name: "Salvar Configuração" });
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(() => expect(state.success).toHaveBeenCalled());
  expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ unrelated: "keep", follow_up: expect.any(Object) }) }));
 });
});
