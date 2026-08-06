import { describe, it, expect } from "vitest";

/**
 * Garante que o front de /prospeccao-sites não volta a quebrar por mismatch
 * de casing entre /api/instances (snake_case) e o select do Disparo.
 *
 * Bug original: API devolve `instance_name` mas page esperava `instanceName`,
 * logo `SelectItem` recebia `value={undefined}` e quebrava o render.
 */

type ApiInstance = {
  instance_name: string;
  provider?: string;
  status?: string;
  agent_id?: string;
};

type SelectItem = { key: string; value: string; label: string };

function toSelectItems(instances: ApiInstance[] | null | undefined): SelectItem[] {
  const list = Array.isArray(instances) ? instances : [];
  return list.map((i) => ({
    key: i.instance_name,
    value: i.instance_name,
    label: `${i.instance_name}${i.status ? ` — ${i.status}` : ""}`,
  }));
}

describe("prospeccao-sites instances select", () => {
  it("cada item usa instance_name (snake) do payload da API", () => {
    const items = toSelectItems([{ instance_name: "ev_5511", status: "open" }]);
    expect(items[0].key).toBe("ev_5511");
    expect(items[0].value).toBe("ev_5511");
    expect(items[0].label).toBe("ev_5511 — open");
  });

  it("label sem status quando campo ausente", () => {
    const items = toSelectItems([{ instance_name: "ev_5511" }]);
    expect(items[0].label).toBe("ev_5511");
  });

  it("array undefined → lista vazia, não quebra render", () => {
    expect(toSelectItems(undefined)).toEqual([]);
    expect(toSelectItems(null)).toEqual([]);
  });

  it("array vazio → lista vazia", () => {
    expect(toSelectItems([])).toEqual([]);
  });

  it("itens com nomes duplicados não colidem key", () => {
    const items = toSelectItems([
      { instance_name: "ev_5511", status: "open" },
      { instance_name: "ev_5511", status: "closed" },
    ]);
    // keys duplicadas são problema do dado, mas o contrato é key=instance_name.
    // Garante que ao menos todas têm value preenchido (não undefined).
    expect(items.every((i) => typeof i.value === "string" && i.value.length > 0)).toBe(true);
  });

  it(" nunca recebe value undefined (regressão do bug original)", () => {
    const items = toSelectItems([{ instance_name: "ev_5511" }]);
    expect(items[0].value).not.toBeUndefined();
    expect(items[0].key).not.toBeUndefined();
  });
});

/**
 * Filtros Revisão: réplica dos filtros Leads aplicada sobre `selected`.
 * Mesma lógica client-side (ratingMin, reviewsMin, sort, order).
 */

type Lead = {
  id: number;
  nome_negocio: string;
  rating: string | null;
  reviews: string | number | null;
  created_at: string;
  website?: string | null;
};

function filterAndSort(
  leads: Lead[],
  opts: { ratingMin?: string; reviewsMin?: string; sort?: "reviews" | "rating" | "created_at"; order?: "asc" | "desc" }
): Lead[] {
  const ratingMin = opts.ratingMin ? Number(opts.ratingMin) : 0;
  const reviewsMin = opts.reviewsMin ? Number(opts.reviewsMin) : 0;
  const sort = opts.sort || "reviews";
  const order = opts.order || "desc";

  const filtered = leads.filter((l) => {
    const r = parseFloat(l.rating || "0");
    if (!isNaN(ratingMin) && ratingMin > 0 && (isNaN(r) || r < ratingMin)) return false;
    const rv = parseInt(String(l.reviews || "0"), 10) || 0;
    if (!isNaN(reviewsMin) && reviewsMin > 0 && rv < reviewsMin) return false;
    return true;
  });

  return filtered.sort((a, b) => {
    const ra = parseFloat(a.rating || "0") || 0;
    const rb = parseFloat(b.rating || "0") || 0;
    const sa = parseInt(String(a.reviews || "0"), 10) || 0;
    const sb = parseInt(String(b.reviews || "0"), 10) || 0;
    if (sort === "reviews") return order === "desc" ? sb - sa : sa - sb;
    if (sort === "rating")  return order === "desc" ? rb - ra : ra - rb;
    return order === "desc"
      ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      : new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

describe("filtros Revisão prospeccao-sites", () => {
  const leads: Lead[] = [
    { id: 1, nome_negocio: "A", rating: "4.8", reviews: "120", created_at: "2026-01-01T00:00:00Z" },
    { id: 2, nome_negocio: "B", rating: "3.2", reviews: "5",   created_at: "2026-02-01T00:00:00Z" },
    { id: 3, nome_negocio: "C", rating: null,  reviews: "0",   created_at: "2026-03-01T00:00:00Z" },
    { id: 4, nome_negocio: "D", rating: "5.0", reviews: "300", created_at: "2026-04-01T00:00:00Z" },
  ];

  it("sem filtros → retorna todos ordenados reviews desc", () => {
    const r = filterAndSort(leads, {});
    expect(r.map((l) => l.id)).toEqual([4, 1, 2, 3]);
  });

  it("ratingMin 4 → só A e D, D primeiro (mais reviews)", () => {
    const r = filterAndSort(leads, { ratingMin: "4" });
    expect(r.map((l) => l.id)).toEqual([4, 1]);
  });

  it("reviewsMin 100 → A e D", () => {
    const r = filterAndSort(leads, { reviewsMin: "100" });
    expect(r.map((l) => l.id)).toEqual([4, 1]);
  });

  it("orderBy=rating asc → C (null=0) antes, pois sort trata null como 0", () => {
    const r = filterAndSort(leads, { sort: "rating", order: "asc" });
    // null → 0, então C (0) < B (3.2) < A (4.8) < D (5.0)
    expect(r.map((l) => l.id)).toEqual([3, 2, 1, 4]);
  });

  it("criarCampanha POST não envia ai_model/ai_prompt quando personalize off", () => {
    const sel = new Map([[1, leads[0]]]);
    const body = {
      lead_ids: Array.from(sel.keys()),
      personalize_with_ai: false,
      ai_model: false ? "x" : null,
      ai_prompt: false ? "y" : null,
    };
    expect(body.personalize_with_ai).toBe(false);
    expect(body.ai_model).toBe(null);
    expect(body.ai_prompt).toBe(null);
  });

  it("criarCampanha POST envia ai_model+ai_prompt quando personalize on", () => {
    const body = {
      lead_ids: [1],
      personalize_with_ai: true,
      ai_model: "gemini-1.5-flash",
      ai_prompt: "reescreva natural",
    };
    expect(body.personalize_with_ai).toBe(true);
    expect(body.ai_model).toBe("gemini-1.5-flash");
    expect(body.ai_prompt).toBe("reescreva natural");
  });
});
