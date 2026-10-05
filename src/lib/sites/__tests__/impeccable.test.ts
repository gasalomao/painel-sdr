import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import upstream from "../impeccable/upstream.json";
import { composeImpeccableGuidance, DESIGN_DIRECTION_FIELDS, IMPECCABLE_FOUNDATIONS, impeccableReference, impeccableReferenceCatalog, impeccableReviewChecks, isEstablishedWebsite, parseWebsiteDesignDirection } from "../impeccable";
import { getCleanStarterFiles, getStarterFiles } from "../starter";
import { WebsiteTools } from "../tools";

describe("official Impeccable integration", () => {
  it("pins every complete reference and its license with reproducible hashes", () => {
    expect(upstream.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(upstream.documents.LICENSE).toContain("Apache License");
    expect(impeccableReferenceCatalog().length).toBeGreaterThan(35);
    for (const [path, content] of Object.entries(upstream.documents)) {
      expect(createHash("sha256").update(content).digest("hex")).toBe(upstream.sha256[path as keyof typeof upstream.sha256]);
    }
  });

  it("injects every foundation IN FULL for new sites and redesigns, and preserves established small sites", () => {
    for (const files of [undefined, getStarterFiles(), getCleanStarterFiles()]) {
      const prompt = composeImpeccableGuidance(files, "Crie uma loja de instrumentos de corda");
      for (const name of IMPECCABLE_FOUNDATIONS) expect(prompt).toContain(impeccableReference(name));
      expect(prompt).toContain("CRIAÇÃO / NOVA DIREÇÃO");
    }
    const existing = { "src/App.tsx": 'export default function App() { return <main>Marca confirmada</main>; }' };
    expect(isEstablishedWebsite(existing)).toBe(true);
    const refinement = composeImpeccableGuidance(existing, "troque a cor do botão");
    expect(refinement).toContain(impeccableReference("craft-floor"));
    expect(refinement).toContain(impeccableReference("colorize"));
    expect(refinement).not.toContain(impeccableReference("new-work"));
    expect(composeImpeccableGuidance(existing, "recrie o site do zero")).toContain(impeccableReference("new-work"));
  });

  it("makes every reference recoverable through bounded reads only while enabled", async () => {
    const off = new WebsiteTools(getStarterFiles(), { context: {}, assets: [] });
    await expect(off.execute("read_design_reference", { name: "typeset" })).rejects.toThrow();
    const on = new WebsiteTools(getStarterFiles(), { context: {}, assets: [], impeccable: true });
    let content = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await on.execute("read_design_reference", { name: "new-work", offset, limit: 19000 }) as { content: string; nextOffset: number | null };
      content += result.content;
      offset = result.nextOffset;
    }
    expect(content).toBe(impeccableReference("new-work"));
    await expect(on.execute("read_design_reference", { name: "../../.env" })).rejects.toThrow();
    await expect(on.execute("read_design_reference", { name: "skill", limit: 20001 })).rejects.toThrow();
  });

  it("stores concrete direction outside all public files and rejects incomplete records", async () => {
    const files = getStarterFiles();
    const tools = new WebsiteTools(files, { context: {}, assets: [], impeccable: true });
    const direction = { mode: "persuade", ...Object.fromEntries(DESIGN_DIRECTION_FIELDS.map((field) => [field, `Decisão específica de ${field} para oficina de violinos.`])) };
    await tools.execute("record_design_direction", direction);
    expect(tools.designDirection).toEqual(direction);
    expect(tools.files).toEqual(files);
    expect(() => parseWebsiteDesignDirection({ mode: "persuade", thesis: "bonito" })).toThrow();
    expect(() => impeccableReviewChecks([])).toThrow();
    expect(() => impeccableReviewChecks([{ dimension: "specificity", passed: true, evidence: "Sim" }])).toThrow();
  });
});


it("requires a concrete direction before source mutation on new work", async () => {
  const files = getStarterFiles();
  const tools = new WebsiteTools(files, { context: {}, assets: [], impeccable: true, requireDesignDirection: true });
  await expect(tools.execute("write", { path: "src/App.tsx", content: "replacement" })).rejects.toThrow("record_design_direction");
  expect(tools.files).toEqual(files);
  expect(await tools.execute("read", { path: "src/App.tsx" })).toBeDefined();
});
