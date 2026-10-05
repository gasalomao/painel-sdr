import { describe, expect, it } from "vitest";
import { compactWebsiteToolHistory } from "../agent-context";
import { requestsWebsiteLogo, resolveWebsiteUploadPurpose } from "../asset-intent";

describe("recoverable tool context", () => {
  it("reduces repeated source payloads while preserving instructions, images, tool pairs and recent code", () => {
    const messages = [
      { role: "system", content: "SECURITY" },
      { role: "user", content: [{ type: "text", text: "Use this logo" }, { type: "image_url", image_url: { url: "https://example.test/logo.png" } }] },
      ...Array.from({ length: 8 }, (_, index) => [
        { role: "assistant", content: null, tool_calls: [{ id: `r${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) } }] },
        { role: "tool", tool_call_id: `r${index}`, content: JSON.stringify({ content: "x".repeat(20000), total: 20000 }) },
      ]).flat(),
    ];
    const original = JSON.stringify(messages);
    const compact = compactWebsiteToolHistory(messages);
    expect(JSON.stringify(compact).length).toBeLessThan(original.length * 0.3);
    expect(compact.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(compact.slice(-4)).toEqual(messages.slice(-4));
    expect(compact).toHaveLength(messages.length);
    expect(JSON.stringify(messages)).toBe(original);
    expect(JSON.stringify(compact[3])).toContain("read/search");
  });

  it("keeps errors and compacts old writes as valid JSON without changing the latest rounds", () => {
    const write = { role: "assistant", content: null, tool_calls: [{ id: "w1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "src/App.tsx", content: "a".repeat(10000) }) } }] };
    const recent = { role: "assistant", content: null, tool_calls: [] };
    const result = compactWebsiteToolHistory([write, { role: "tool", content: '{"saved":"src/App.tsx"}', tool_call_id: "w1" }, recent, recent]);
    expect(JSON.stringify(result[0])).not.toContain("a".repeat(10000));
    expect(result[1]).toEqual({ role: "tool", content: '{"saved":"src/App.tsx"}', tool_call_id: "w1" });
  });
});

describe("logo intent after attachment", () => {
  it("resolves a single pasted image using the final prompt", () => {
    expect(resolveWebsiteUploadPurpose({ purpose: "content" }, "coloque essa logo no site", 1)).toBe("logo");
    expect(resolveWebsiteUploadPurpose({ purpose: "reference", purposeExplicit: true }, "coloque essa logo no site", 1)).toBe("reference");
    expect(resolveWebsiteUploadPurpose({ purpose: "content" }, "coloque essa logo no site", 2)).toBe("content");
    expect(requestsWebsiteLogo("não coloque essa logo")).toBe(false);
    expect(requestsWebsiteLogo("remova a logo")).toBe(false);
    expect(requestsWebsiteLogo("analise a logo")).toBe(false);
  });
});


it("does not omit historical tool errors", () => {
  const messages = [
    { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read", arguments: '{"path":"src/App.tsx"}' } }] },
    { role: "tool", tool_call_id: "r", content: JSON.stringify({ error: "x".repeat(3000) }) },
    { role: "assistant", content: null, tool_calls: [] },
    { role: "assistant", content: null, tool_calls: [] },
  ];
  expect(compactWebsiteToolHistory(messages)[1]).toEqual(messages[1]);
});
