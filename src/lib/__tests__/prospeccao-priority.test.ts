import { describe, it, expect } from "vitest";
import { computePriority, passesFilters, ProspecLeadInput } from "../prospeccao-priority";

describe("computePriority", () => {
  it("reviews desc → maior reviews vence", () => {
    const a: ProspecLeadInput = { reviews: "300", avaliacao: "4.5", created_at: "2026-01-01T00:00:00Z" };
    const b: ProspecLeadInput = { reviews: "5",   avaliacao: "5.0", created_at: "2026-01-02T00:00:00Z" };
    expect(computePriority(a, "reviews", "desc")).toBeGreaterThan(computePriority(b, "reviews", "desc"));
  });

  it("reviews asc → menor reviews vence (priority maior)", () => {
    const a: ProspecLeadInput = { reviews: "300" };
    const b: ProspecLeadInput = { reviews: "5" };
    expect(computePriority(b, "reviews", "asc")).toBeGreaterThan(computePriority(a, "reviews", "asc"));
  });

  it("rating desc → maior rating vence", () => {
    const a: ProspecLeadInput = { avaliacao: "4.8", reviews: "10" };
    const b: ProspecLeadInput = { avaliacao: "3.2", reviews: "999" };
    expect(computePriority(a, "rating", "desc")).toBeGreaterThan(computePriority(b, "rating", "desc"));
  });

  it("rating com 2 casas — 4.85 vence 4.8", () => {
    const a: ProspecLeadInput = { avaliacao: "4.85" };
    const b: ProspecLeadInput = { avaliacao: "4.80" };
    expect(computePriority(a, "rating", "desc")).toBeGreaterThan(computePriority(b, "rating", "desc"));
  });

  it("created_at desc → mais velho vence (score=-t, desc pega maior score = menos negativo = t menor)", () => {
    const oldLead: ProspecLeadInput = { created_at: "2026-01-01T00:00:00Z" };
    const newLead: ProspecLeadInput = { created_at: "2026-02-01T00:00:00Z" };
    expect(computePriority(oldLead, "created_at", "desc")).toBeGreaterThan(computePriority(newLead, "created_at", "desc"));
  });

  it("created_at asc → mais novo vence (inverte)", () => {
    const oldLead: ProspecLeadInput = { created_at: "2026-01-01T00:00:00Z" };
    const newLead: ProspecLeadInput = { created_at: "2026-02-01T00:00:00Z" };
    expect(computePriority(newLead, "created_at", "asc")).toBeGreaterThan(computePriority(oldLead, "created_at", "asc"));
  });

  it("reviews ausente → 0", () => {
    expect(computePriority({}, "reviews", "desc")).toBe(0);
  });

  it("rating null/não-numérico → 0", () => {
    expect(computePriority({ avaliacao: null }, "rating", "desc")).toBe(0);
    expect(computePriority({ avaliacao: "n/a" }, "rating", "desc")).toBe(0);
  });
});

describe("passesFilters", () => {
  it("sem filtros → passa tudo", () => {
    expect(passesFilters({ reviews: "0", avaliacao: "0" }, 0, 0)).toBe(true);
    expect(passesFilters({ reviews: "999", avaliacao: "5.0" }, 0, 0)).toBe(true);
  });

  it("min_reviews filtra abaixo", () => {
    expect(passesFilters({ reviews: "50", avaliacao: "4.0" }, 100, 0)).toBe(false);
    expect(passesFilters({ reviews: "150", avaliacao: "4.0" }, 100, 0)).toBe(true);
  });

  it("min_rating filtra abaixo", () => {
    expect(passesFilters({ reviews: "10", avaliacao: "3.0" }, 0, 4)).toBe(false);
    expect(passesFilters({ reviews: "10", avaliacao: "4.5" }, 0, 4)).toBe(true);
  });

  it("ambos filtros AND", () => {
    expect(passesFilters({ reviews: "50", avaliacao: "5.0" }, 100, 4)).toBe(false);
    expect(passesFilters({ reviews: "200", avaliacao: "3.0" }, 100, 4)).toBe(false);
    expect(passesFilters({ reviews: "200", avaliacao: "4.8" }, 100, 4)).toBe(true);
  });

  it("reviews não-numérico → 0 → filtrado se min>0", () => {
    expect(passesFilters({ reviews: "n/a", avaliacao: "5.0" }, 1, 0)).toBe(false);
  });
});
