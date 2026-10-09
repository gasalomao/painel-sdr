import { describe, expect, it } from "vitest";
import { WebsiteTools } from "../tools";
import { getStarterFiles } from "../starter";

const workspace = () => ({ ...getStarterFiles(), "src/example.ts": "const café = 'ação';\r\nconst next = 1;\r\nconst tail = 2;\r\n" });

describe("restricted website edits", () => {
  it("reports React-only JSX attribute mistakes before a costly build without rewriting source", async () => {
    const files = { ...workspace(), "src/App.tsx": 'export default function App(){return <main class="hero"><label for="nome">Nome</label><input id="nome"/></main>}' };
    const tools = new WebsiteTools(files, { context: {}, assets: [] });
    const result = await tools.execute("run_validation", {}) as { passed: boolean; errors: string[] };
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("className");
    expect(result.errors.join("\n")).toContain("htmlFor");
    expect(tools.files).toEqual(files);
    await tools.execute("write", { path: "src/App.tsx", content: files["src/App.tsx"].replace('class="hero"', 'className="hero"').replace('for="nome"', 'htmlFor="nome"') });
    expect(await tools.execute("run_validation", {})).toMatchObject({ passed: true });
  });

  it("diagnoses camel-case intrinsic SVG attributes but ignores TypeScript properties", async () => {
    const tools = new WebsiteTools({ ...workspace(), "src/App.tsx": 'export default function App(){return <svg><linearGradient class="gradient"/><clipPath class="clip"/></svg>}', "src/data.ts": 'export const data={class:"valid",for:"valid"};' }, { context: {}, assets: [] });
    const result = await tools.execute("run_validation", {}) as { passed: boolean; errors: string[] };
    expect(result.passed).toBe(false);
    expect(result.errors.filter(error => error.includes("className"))).toHaveLength(2);
    expect(result.errors.join("\n")).not.toContain("src/data.ts");
  });

  it("does not rewrite or reject class props on custom components or web components", async () => {
    const tools = new WebsiteTools({ ...workspace(), "src/App.tsx": 'function Custom(props:{class:string}){return <p>{props.class}</p>}export default function App(){return <><Custom class="data"/><agri-card class="web"/></>}' }, { context: {}, assets: [] });
    expect(await tools.execute("run_validation", {})).toMatchObject({ passed: true });
  });
  it.each(["write", "create", "delete", "rename", "restore", "record_design_direction"])("blocks %s in definitions and execution", async (name) => {
    const files = workspace();
    const tools = new WebsiteTools(files, { context: {}, assets: [], patchOnly: true, impeccable: true });
    expect(tools.definitions.some((tool) => tool.function.name === name)).toBe(false);
    await expect(tools.execute(name, { path: "src/example.ts", content: "replacement" })).rejects.toThrow("pontual");
    expect(tools.files).toEqual(files);
  });

  it("enforces create absent and write present atomically", async () => {
    const files = workspace();
    const tools = new WebsiteTools(files, { context: {}, assets: [] });
    await expect(tools.execute("create", { path: "src/example.ts", content: "replacement" })).rejects.toThrow("já existe");
    await expect(tools.execute("write", { path: "src/absent.ts", content: "replacement" })).rejects.toThrow("inexistente");
    expect(tools.files).toEqual(files);
  });

  it("matches LF patches to CRLF without changing untouched bytes", async () => {
    const files = workspace();
    const tools = new WebsiteTools(files, { context: {}, assets: [], patchOnly: true });
    await tools.execute("patch", { path: "src/example.ts", old: "const café = 'ação';\nconst next = 1;", new: "const café = 'São João';\nconst next = 3;" });
    expect(tools.files["src/example.ts"]).toBe("const café = 'São João';\r\nconst next = 3;\r\nconst tail = 2;\r\n");
    expect(files["src/example.ts"]).toContain("'ação'");
  });

  it.each([null, undefined, [], "patch", 3])("rejects invalid tool input %s", async (input) => {
    const tools = new WebsiteTools(workspace(), { context: {}, assets: [] });
    await expect(tools.execute("patch", input)).rejects.toThrow("Argumentos inválidos");
  });

  it.each(["absent", "const", ""])("rejects absent, ambiguous or empty search %s without changing files", async (old) => {
    const files = workspace();
    const tools = new WebsiteTools(files, { context: {}, assets: [], patchOnly: true });
    await expect(tools.execute("patch", { path: "src/example.ts", old, new: "changed" })).rejects.toThrow();
    expect(tools.files).toEqual(files);
  });

  it("rejects no-op patches", async () => {
    const tools = new WebsiteTools(workspace(), { context: {}, assets: [] });
    await expect(tools.execute("patch", { path: "src/example.ts", old: "next = 1", new: "next = 1" })).rejects.toThrow("não altera");
  });

  it("reads exact numbered lines in a large file without character guessing", async () => {
    const lines = Array.from({ length: 1200 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
    const tools = new WebsiteTools({ ...workspace(), "src/large.ts": lines.join("\r\n") }, { context: {}, assets: [] });
    expect(await tools.execute("read", { path: "src/large.ts", start_line: 1046, end_line: 1050 })).toMatchObject({
      start_line: 1046, end_line: 1050, total_lines: 1200, next_line: 1051,
      content: lines.slice(1045, 1050).map((line, index) => `${1046 + index}: ${line}`).join("\n"),
    });
    expect(await tools.execute("read", { path: "src/large.ts" })).toMatchObject({ start_line: 1, total_lines: 1200 });
  });

  it.each([{ start_line: -1 }, { start_line: 1.5 }, { start_line: "1" }, { start_line: 4, end_line: 2 }, { end_line: 5 }, { start_line: 1, offset: 0 }])("rejects invalid or mixed line ranges %j", async (range) => {
    const tools = new WebsiteTools(workspace(), { context: {}, assets: [] });
    await expect(tools.execute("read", { path: "src/example.ts", ...range })).rejects.toThrow("Intervalo");
  });

  it.each(["🚀".repeat(20000), "漢".repeat(30000), "\u0001".repeat(30000)])("paginates escaped and Unicode source within serialized limits %#", async (content) => {
    const tools = new WebsiteTools({ ...workspace(), "src/large.ts": content }, { context: {}, assets: [] });
    let offset: number | null = 0;
    const pages: string[] = [];
    while (offset !== null) {
      const page = await tools.execute("read", { path: "src/large.ts", offset, limit: 30000 }) as { content: string; next_offset: number | null };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(30000);
      expect(page.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      if (page.next_offset !== null) expect(page.next_offset).toBeGreaterThan(offset);
      pages.push(page.content);
      offset = page.next_offset;
    }
    expect(pages.join("")).toBe(content);
  });

  it("paginates numbered escaped lines instead of overflowing the final tool result", async () => {
    const lines = Array.from({ length: 100 }, () => "\u0001".repeat(250));
    const tools = new WebsiteTools({ ...workspace(), "src/escaped.ts": lines.join("\r\n") }, { context: {}, assets: [] });
    const first = await tools.execute("read", { path: "src/escaped.ts", start_line: 1, end_line: 100 }) as { content: string; end_line: number; next_line: number };
    expect(first.next_line).toBe(first.end_line + 1);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(30000);
    expect(first.content.split("\n")).toEqual(lines.slice(0, first.end_line).map((line, index) => `${index + 1}: ${line}`));
  });

  it("uses character fallback for a giant line and handles EOF explicitly", async () => {
    const tools = new WebsiteTools({ ...workspace(), "src/giant.ts": "漢".repeat(20000), "src/empty.ts": "" }, { context: {}, assets: [] });
    await expect(tools.execute("read", { path: "src/giant.ts" })).rejects.toThrow("offset/limit");
    expect(await tools.execute("read", { path: "src/giant.ts", offset: 20000 })).toMatchObject({ content: "", next_offset: null });
    expect(await tools.execute("read", { path: "src/empty.ts", offset: 0 })).toMatchObject({ content: "", next_offset: null });
    await expect(tools.execute("read", { path: "src/giant.ts", offset: 20001 })).rejects.toThrow("Intervalo");
    await expect(tools.execute("read", { path: "src/giant.ts", start_line: 2 })).rejects.toThrow("Intervalo");
  });

  it("never splits a surrogate pair in one-character pagination and rejects unsafe offsets", async () => {
    const tools = new WebsiteTools({ ...workspace(), "src/unicode.ts": "🚀fim" }, { context: {}, assets: [] });
    expect(await tools.execute("read", { path: "src/unicode.ts", offset: 0, limit: 1 })).toMatchObject({ content: "🚀", next_offset: 2 });
    for (const offset of [1, Number.MAX_SAFE_INTEGER + 1]) await expect(tools.execute("read", { path: "src/unicode.ts", offset })).rejects.toThrow("Intervalo");
  });

  it.each([{ offset: null }, { limit: null }, { start_line: null }, { end_line: null, start_line: 1 }, { offset: NaN }, { limit: Infinity }, { limit: 0 }, { limit: 30001 }])("rejects explicit invalid read bounds %#", async (bounds) => {
    const tools = new WebsiteTools(workspace(), { context: {}, assets: [] });
    await expect(tools.execute("read", { path: "src/example.ts", ...bounds })).rejects.toThrow("Intervalo");
  });

  it("preserves quotes, backslashes, CRLF and isolated surrogates across character pages", async () => {
    const content = ('"\\\t\r\n\ud800texto'.repeat(5000));
    const tools = new WebsiteTools({ ...workspace(), "src/escaped.ts": content }, { context: {}, assets: [] });
    let offset: number | null = 0;
    let recovered = "";
    while (offset !== null) {
      const page = await tools.execute("read", { path: "src/escaped.ts", offset }) as { content: string; next_offset: number | null };
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(30000);
      recovered += page.content;
      offset = page.next_offset;
    }
    expect(recovered).toBe(content);
  });

  it("searches a specific file and leaves unrelated matches out", async () => {
    const tools = new WebsiteTools({ ...workspace(), "src/other.ts": "const tail = 4;" }, { context: {}, assets: [] });
    expect(await tools.execute("search", { query: "tail", path: "src/example.ts" })).toEqual([{ path: "src/example.ts", line: 3, text: "const tail = 2;" }]);
    await expect(tools.execute("search", { query: "tail", path: "../../secret" })).rejects.toThrow();
  });

  it("reports syntax errors with exact line context instead of approving broken TSX", async () => {
    const files = { ...getStarterFiles(), "src/App.tsx": "export default function App() {\n  return <h1 title=>Casa do Agricultor</h1>;\n}\n" };
    const tools = new WebsiteTools(files, { context: {}, assets: [] });
    const result = await tools.execute("run_validation", {}) as { passed: boolean; errors: string[] };
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("src/App.tsx(2,");
    expect(result.errors.join("\n")).toContain("2:   return <h1");
  });

  it("rejects missing local imports before isolated build", async () => {
    const tools = new WebsiteTools({ ...getStarterFiles(), "src/App.tsx": 'import Missing from "./missing"; export default function App(){return <Missing/>;}' }, { context: {}, assets: [] });
    const result = await tools.execute("run_validation", {}) as { passed: boolean; errors: string[] };
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toContain("./missing");
    expect(result.errors.join("\n")).toContain("src/App.tsx(1,");
  });

  it("repairs the diagnosed TSX line in a 75KB file without rewriting other bytes", async () => {
    const lines = Array.from({ length: 1200 }, (_, index) => `// linha ${index + 1}: preserve o conteúdo agrícola existente ${"x".repeat(20)}`);
    lines[1045] = 'export default function App(){return <h1 title=>Casa do Agricultor</h1>;}';
    const original = lines.join("\r\n");
    const tools = new WebsiteTools({ ...getStarterFiles(), "src/App.tsx": original }, { context: {}, assets: [] });
    const failed = await tools.execute("run_validation", {}) as { errors: string[] };
    expect(failed.errors.join("\n")).toContain("src/App.tsx(1046,");
    await tools.execute("patch", { path: "src/App.tsx", old: "<h1 title=>", new: '<h1 title="Loja agrícola">' });
    expect(tools.files["src/App.tsx"]).toBe(original.replace("<h1 title=>", '<h1 title="Loja agrícola">'));
    expect(await tools.execute("run_validation", {})).toMatchObject({ passed: true, scope: "static" });
  });

  it("reports static validation only, never build or visual approval", async () => {
    const tools = new WebsiteTools(getStarterFiles(), { context: {}, assets: [] });
    expect(await tools.execute("run_validation", {})).toMatchObject({ scope: "static", build: "pending", visual: "pending" });
    expect(JSON.stringify(await tools.execute("run_validation", {}))).not.toContain("100%");
  });
});
