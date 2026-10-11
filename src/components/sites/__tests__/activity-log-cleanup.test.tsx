import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { ActivityLog } from "../ActivityLog";
import { useActivityLogs } from "@/lib/sites/activity-log-ui";
const streams: FakeEventSource[] = [];
class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { streams.push(this); }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); streams.splice(0); });
function setup() {
  vi.stubGlobal("EventSource", FakeEventSource);
  const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>(resolve => { pending.push({ resolve, signal: init.signal as AbortSignal }); })));
  return pending;
}
describe("activity log lifecycle", () => {
  it("aborts old fetches and closes old streams when the run changes", async () => {
    const pending = setup();
    const { rerender, unmount } = render(<ActivityLog runId="old" />);
    rerender(<ActivityLog runId="new" />);
    expect(pending[0].signal.aborted).toBe(true);
    expect(streams[0].close).toHaveBeenCalledOnce();
    await act(async () => {
      pending[1].resolve(Response.json({ activities: [{ id: "new", type: "info", message: "Atividade nova", timestamp: 1 }] }));
    });
    await act(async () => {
      pending[0].resolve(Response.json({ activities: [{ id: "old", type: "info", message: "Atividade antiga", timestamp: 1 }] }));
    });
    expect(screen.getByText("Atividade nova")).toBeInTheDocument();
    expect(screen.queryByText("Atividade antiga")).not.toBeInTheDocument();
    unmount();
    expect(pending[1].signal.aborted).toBe(true);
    expect(streams[1].close).toHaveBeenCalledOnce();
  });
  it("keeps hook responses scoped to the active run and requests an actual stream", async () => {
    const pending = setup();
    const { result, rerender, unmount } = renderHook(({ run }) => useActivityLogs(run), { initialProps: { run: "old" } });
    rerender({ run: "new" });
    expect(streams[1].url).toContain("?stream=true");
    await act(async () => { pending[1].resolve(Response.json({ activities: [{ id: "new" }] })); });
    await act(async () => { pending[0].resolve(Response.json({ activities: [{ id: "old" }] })); });
    expect(result.current.activities).toEqual([{ id: "new" }]);
    unmount();
    expect(pending.every(request => request.signal.aborted)).toBe(true);
    expect(streams.every(stream => stream.close.mock.calls.length === 1)).toBe(true);
  });
});
