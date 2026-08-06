import { describe, it, expect } from "vitest";

/**
 * Replica do ordering que campaign-worker.ts aplica ao claim prÓximo target.
 * Worker faz:
 *   .from("campaign_targets")
 *   .eq("campaign_id", c.id)
 *   .eq("status", "pending")
 *   .order("priority", { ascending: false })
 *   .order("created_at", { ascending: true })
 *   .limit(1)
 *   .maybeSingle()
 *
 * Testamos só o && here‑rope entirely: maior priority vence, empate por created_at asc.
 */

type Target = { id: number; priority: number; created_at: string };

function nextPending(targets: Target[]): Target | null {
  if (!targets.length) return null;
  const sorted = [...targets].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
  return sorted[0];
}

describe("campaign_targets ordering (priority DESC, created_at ASC)", () => {
  it("maior priority vence", () => {
    const t: Target[] = [
      { id: 1, priority: 10, created_at: "2026-01-03T00:00:00Z" },
      { id: 2, priority: 999, created_at: "2026-01-01T00:00:00Z" },
      { id: 3, priority: 50, created_at: "2026-01-02T00:00:00Z" },
    ];
    expect(nextPending(t)?.id).toBe(2);
  });

  it("empate priority → mais velho (created_at asc) vence", () => {
    const t: Target[] = [
      { id: 1, priority: 100, created_at: "2026-01-03T00:00:00Z" },
      { id: 2, priority: 100, created_at: "2026-01-01T00:00:00Z" },
      { id: 3, priority: 100, created_at: "2026-01-02T00:00:00Z" },
    ];
    expect(nextPending(t)?.id).toBe(2);
  });

  it("lista vazia → null", () => {
    expect(nextPending([])).toBeNull();
  });

  it("priority negativa ainda ordena (lead novo com created_at antigo)", () => {
    const t: Target[] = [
      { id: 1, priority: -1760000000000, created_at: "2026-01-01T00:00:00Z" },
      { id: 2, priority: -1700000000000, created_at: "2026-01-02T00:00:00Z" },
    ];
    expect(nextPending(t)?.id).toBe(2);
  });

  it("priority 0 em todos → fallback created_at asc", () => {
    const t: Target[] = [
      { id: 1, priority: 0, created_at: "2026-03-01T00:00:00Z" },
      { id: 2, priority: 0, created_at: "2026-01-01T00:00:00Z" },
      { id: 3, priority: 0, created_at: "2026-02-01T00:00:00Z" },
    ];
    expect(nextPending(t)?.id).toBe(2);
  });
});
