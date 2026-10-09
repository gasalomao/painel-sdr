import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SandpackProvider, useSandpack } from "@codesandbox/sandpack-react";
import { getSitePreviewFiles, SITE_PREVIEW_SETUP } from "@/components/sites/site-preview";
import { getStarterFiles, WEBSITE_FIXED_FILES } from "../starter";
import { getWebsiteAssetReferences, resolveWebsitePreviewAssets } from "../asset-preview";
import type { WebsiteAsset, WebsiteFiles } from "../types";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const path = `/assets/${assetId}.png`;
const asset: WebsiteAsset = {
  id: assetId, client_id: clientId, project_id: projectId, name: "logo.png",
  path: `${clientId}/${projectId}/${assetId}.png`, mime: "image/png", size: 68,
  width: 1, height: 1, purpose: "logo", status: "ready", created_at: "2026-09-17T00:00:00Z",
  url: "https://storage.example.test/signed?token=temporary",
};
const scope = { client_id: clientId, id: projectId };

describe("website browser preview contract", () => {
  function code(files: ReturnType<typeof getSitePreviewFiles>, path: string): string {
    const file = files[path];
    if (!file) throw new Error(`Missing preview file: ${path}`);
    return typeof file === "string" ? file : file.code;
  }

  it("uses the real starter entry and fixed React dependencies without Nodebox scripts or preset demo files", () => {
    const source = Object.freeze(getStarterFiles());
    const preview = getSitePreviewFiles(source);
    function PreviewState() {
      const { sandpack } = useSandpack();
      return createElement("output", {
        "data-environment": sandpack.environment,
        "data-files": Object.keys(sandpack.files).sort().join("|"),
        "data-main": JSON.parse(sandpack.files["/package.json"].code).main,
      });
    }
    const markup = renderToStaticMarkup(createElement(SandpackProvider, { files: preview, customSetup: SITE_PREVIEW_SETUP }, createElement(PreviewState)));
    expect(markup).toContain(renderToStaticMarkup(createElement("output", {
      "data-environment": "create-react-app",
      "data-files": Object.keys(preview).sort().join("|"),
      "data-main": "/index.tsx",
    })));
    const pkg = JSON.parse(code(preview, "/package.json"));
    expect(pkg).toEqual({ private: true, main: "/index.tsx", dependencies: JSON.parse(WEBSITE_FIXED_FILES["package.json"]).dependencies });
    expect(code(preview, "/index.tsx")).toContain('require("./src/main.tsx")');
    for (const [path, content] of Object.entries(source).filter(([path]) => path.startsWith("src/"))) expect(code(preview, `/${path}`)).toBe(content);
    expect(code(preview, "/index.html")).toBe(source["index.html"]);
    for (const path of ["/App.tsx", "/styles.css", "/vite.config.js", "/vite.config.ts", "/tsconfig.json"]) expect(preview[path]).toBeUndefined();
    expect(source["package.json"]).toBe(WEBSITE_FIXED_FILES["package.json"]);
    expect(source["src/main.tsx"]).toContain('import "./tokens.css"');
  });

  it("creates the HTML mount, language and title before evaluating main.tsx, keeping arbitrary HTML out of bootstrap code", () => {
    const html = '<html lang="pt-BR"><head><title>Ateliê "Horizonte"</title><script>throw new Error("not executed")</script></head><body><div id="root"></div></body></html>';
    const preview = getSitePreviewFiles({ ...getStarterFiles(), "index.html": html });
    let parsed = "";
    let removedScripts = false;
    let mounted = false;
    const document = { documentElement: { lang: "" }, title: "", head: { append: (...nodes: unknown[]) => expect(nodes).toEqual(["title"]) }, body: { replaceChildren: (...nodes: unknown[]) => { expect(nodes).toEqual(["root"]); mounted = true; } } };
    class DOMParser {
      parseFromString(value: string, mime: string) {
        parsed = value;
        expect(mime).toBe("text/html");
        return { documentElement: { lang: "pt-BR" }, title: 'Ateliê "Horizonte"', head: { children: ["title"] }, body: { childNodes: ["root"] }, querySelectorAll: (selector: string) => { expect(selector).toBe("script"); return [{ remove: () => { removedScripts = true; } }]; } };
      }
    }
    runInNewContext(code(preview, "/index.tsx"), { DOMParser, document, window: { addEventListener() {}, removeEventListener() {} }, require: (path: string) => { expect(path).toBe("./src/main.tsx"); expect(mounted && removedScripts).toBe(true); expect(document.documentElement.lang).toBe("pt-BR"); expect(document.title).toBe('Ateliê "Horizonte"'); } });
    expect(parsed).toBe(html);
  });

  it("adds a trusted commit/effect probe only for an explicitly scoped candidate", () => {
    const preview = getSitePreviewFiles(getStarterFiles(), [], undefined, { id: "candidate-1", origin: "https://operator.example.test" });
    expect(code(preview, "/index.tsx")).toContain('require("react-dom/client")');
    expect(code(preview, "/index.tsx")).toContain("useEffect");
    expect(code(preview, "/index.tsx")).toContain("candidate-1");
    expect(code(preview, "/index.tsx")).toContain("https://operator.example.test");
    expect(code(preview, "/src/main.tsx")).toBe(getStarterFiles()["src/main.tsx"]);
    expect(code(getSitePreviewFiles(getStarterFiles()), "/index.tsx")).toContain("const candidate = null;");
  });

  it("renders runtime error messages as text, never injected HTML", () => {
    const preview = getSitePreviewFiles(getStarterFiles());
    expect(code(preview, "/index.tsx")).not.toContain("innerHTML");
    expect(code(preview, "/index.tsx")).toContain("textContent");
  });

  function runtimeHarness(failure?: unknown) {
    const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
    type Node = { tag: string; children: Node[]; style: { cssText: string; whiteSpace: string }; textContent: string; attributes: Record<string, string>; shadow?: Node; append: (...nodes: Node[]) => void; prepend: (...nodes: Node[]) => void; remove: () => void; setAttribute: (key: string, value: string) => void; attachShadow: () => Node };
    const nodes: Node[] = [];
    const element = (tag: string): Node => {
      const node: Node = { tag, children: [], style: { cssText: "", whiteSpace: "" }, textContent: "", attributes: {},
        append: (...children) => { node.children.push(...children); }, prepend: (...children) => { node.children.unshift(...children); },
        remove: () => { for (const parent of nodes) parent.children = parent.children.filter(child => child !== node); },
        setAttribute: (key, value) => { node.attributes[key] = value; }, attachShadow: () => { node.shadow = element("shadow"); return node.shadow; } };
      nodes.push(node);
      return node;
    };
    const root = element("root");
    const body = Object.assign(element("body"), { replaceChildren: (...children: Node[]) => { body.children = children; } });
    const head = element("head");
    const sandpackStyle = element("sandpack-style");
    head.append(sandpackStyle);
    const document = { documentElement: { lang: "" }, title: "", head, body, createElement: element, getElementById: () => root };
    class DOMParser {
      parseFromString() { return { documentElement: { lang: "pt-BR" }, title: "Fixture", head: { children: [element("style")] }, body: { childNodes: [root] }, querySelectorAll: () => [] }; }
    }
    const window = {
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(listener); },
      removeEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => { listeners.get(name)?.delete(listener); },
    };
    let dispose: (() => void) | undefined;
    const require = vi.fn(() => { if (failure !== undefined) throw failure; });
    const source = code(getSitePreviewFiles(getStarterFiles()), "/index.tsx");
    // Only the operator bootstrap runs in the VM; generated sources are never evaluated.
    const statusHandlers = new Set<(status: string) => void>();
    const hot = {
      dispose: (callback: () => void) => { dispose = callback; },
      addStatusHandler: (callback: (status: string) => void) => { statusHandlers.add(callback); },
      removeStatusHandler: (callback: (status: string) => void) => { statusHandlers.delete(callback); },
    };
    const run = () => runInNewContext(source, { DOMParser, document, window, console: { error() {} }, module: { hot }, require });
    const emit = (name: string, event: Record<string, unknown>) => { for (const listener of listeners.get(name) ?? []) listener(event); };
    const alerts = () => body.children.flatMap(host => host.shadow?.children ?? []).filter(node => node.attributes.role === "alert");
    const updateStatus = (status: string) => { for (const handler of statusHandlers) handler(status); };
    return { run, emit, alerts, body, root, head, sandpackStyle, listeners, statusHandlers, updateStatus, require, dispose: () => dispose?.() };
  }

  it("captures async errors and rejected promises as one isolated text alert outside React root", () => {
    const runtime = runtimeHarness();
    runtime.run();
    expect(runtime.alerts()).toHaveLength(0);
    runtime.emit("error", { error: new Error("React render failed") });
    expect(runtime.alerts()).toHaveLength(1);
    expect(runtime.alerts()[0].children[1].textContent).toBe("React render failed");
    runtime.emit("unhandledrejection", { reason: '<img src=x onerror="attack()">' });
    expect(runtime.alerts()).toHaveLength(1);
    expect(runtime.alerts()[0].children[1].textContent).toBe('<img src=x onerror="attack()">');
    expect(runtime.root.children).toEqual([]);
  });

  it("bounds errors, tolerates hostile error conversion and does not hide default browser reporting", () => {
    const runtime = runtimeHarness();
    runtime.run();
    const preventDefault = vi.fn();
    runtime.emit("error", { message: "x".repeat(2500), preventDefault });
    expect(runtime.alerts()[0].children[1].textContent).toHaveLength(2000);
    for (const reason of [null, undefined, "", { get message() { throw new Error("getter"); } }, { toString() { throw new Error("conversion"); } }]) {
      runtime.emit("unhandledrejection", { reason });
      expect(runtime.alerts()[0].children[1].textContent).toBe("Falha de execução sem detalhes disponíveis.");
    }
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("keeps synchronous errors outside the React root and disposes subscriptions across bootstrap reloads", () => {
    const runtime = runtimeHarness(new Error("sync failed"));
    runtime.run();
    expect(runtime.alerts()[0].children[1].textContent).toBe("sync failed");
    const stale = [...runtime.listeners.get("error")!][0];
    runtime.run();
    expect(runtime.listeners.get("error")?.size).toBe(1);
    expect(runtime.listeners.get("unhandledrejection")?.size).toBe(1);
    runtime.dispose();
    expect(runtime.listeners.get("error")?.size).toBe(0);
    expect(runtime.listeners.get("unhandledrejection")?.size).toBe(0);
    expect(runtime.alerts()).toHaveLength(0);
    stale({ message: "stale event" });
    expect(runtime.alerts()).toHaveLength(0);
  });

  it("clears stale diagnostics at HMR check and keeps evaluation failures through repeated apply and idle", () => {
    const runtime = runtimeHarness();
    runtime.run();
    runtime.emit("error", { error: new Error("old render") });
    runtime.updateStatus("prepare");
    expect(runtime.alerts()).toHaveLength(1);
    runtime.updateStatus("check");
    expect(runtime.alerts()).toHaveLength(0);
    expect(runtime.listeners.get("error")?.size).toBe(1);
    expect(runtime.head.children.map(node => node.tag)).toEqual(["sandpack-style", "style"]);
    runtime.emit("error", { error: new Error("new effect") });
    runtime.updateStatus("apply");
    runtime.updateStatus("apply");
    runtime.updateStatus("idle");
    expect(runtime.alerts()).toHaveLength(1);
    expect(runtime.alerts()[0].children[1].textContent).toBe("new effect");
  });

  it("disposes HMR status handlers and leaves stale callbacks inert", () => {
    const runtime = runtimeHarness();
    runtime.run();
    expect(runtime.statusHandlers.size).toBe(1);
    const stale = [...runtime.statusHandlers][0];
    runtime.run();
    expect(runtime.statusHandlers.size).toBe(1);
    runtime.emit("error", { error: new Error("current error") });
    stale("check");
    expect(runtime.alerts()).toHaveLength(1);
    runtime.dispose();
    expect(runtime.statusHandlers.size).toBe(0);
    expect(runtime.alerts()).toHaveLength(0);
  });

  it("replaces owned HTML head nodes across reloads without removing Sandpack styles", () => {
    const runtime = runtimeHarness();
    runtime.run();
    expect(runtime.head.children.map(node => node.tag)).toEqual(["sandpack-style", "style"]);
    runtime.run();
    expect(runtime.head.children.map(node => node.tag)).toEqual(["sandpack-style", "style"]);
    runtime.dispose();
    expect(runtime.head.children).toEqual([runtime.sandpackStyle]);
  });

  it.each(["invalid\0html", 42, null])("rejects invalid HTML content: %j", (html) => {
    expect(() => getSitePreviewFiles({ ...getStarterFiles(), "index.html": html } as unknown as WebsiteFiles)).toThrow("HTML inválido para pré-visualização");
  });

  it("normalizes source paths and never trusts supplied scripts, dependencies, configs, traversal or NUL bytes", () => {
    const preview = getSitePreviewFiles({
      "/src/main.tsx": "main", "src/App.tsx": "app", "public/logo.svg": "logo", "/index.html": "html",
      "package.json": '{"scripts":{"dev":"run-untrusted"},"dependencies":{"untrusted":"latest"}}',
      "vite.config.js": "untrusted", "src/../package.json": "untrusted", "src//App.tsx": "untrusted", "src/broken.ts": "\0",
    });
    expect(code(preview, "/src/main.tsx")).toBe("main");
    expect(code(preview, "/public/logo.svg")).toBe("logo");
    expect(code(preview, "/index.html")).toBe("html");
    expect(code(preview, "/package.json")).not.toMatch(/untrusted|scripts|vite|typescript/);
    for (const path of ["/vite.config.js", "/src/../package.json", "/src//App.tsx", "/src/broken.ts"]) expect(preview[path]).toBeUndefined();
  });
});

describe("website preview assets", () => {
  it("extracts unique literal local paths in TSX, CSS, HTML and JSON", () => {
    expect(getWebsiteAssetReferences({
      "src/App.tsx": `<img src="${path}"/>`,
      "src/style.css": `a{background:url(${path}?v=1#logo)}`,
      "index.html": `<img src='${path}'>`,
      "src/data.json": JSON.stringify({ image: path }),
    })).toEqual([{ id: assetId, path }]);
  });

  it("does not match external URLs, longer filenames, nested paths or malformed UUIDs", () => {
    expect(getWebsiteAssetReferences({ "src/data.json": [
      `"https://example.test${path}"`, `"/nested${path}"`, `"/${path}"`,
      `"${path}.backup"`, `"${path}/nested"`, '"/assets/not-a-uuid.png"',
    ].join(",") })).toEqual([]);
  });

  it.each(["logo", "content"] as const)("derives preview files for ready %s without mutating sources or assets", (purpose) => {
    const files = Object.freeze({ "src/App.tsx": `<img src="${path}"/>`, "src/style.css": `a{background:url(${path})}` });
    const selected = Object.freeze({ ...asset, purpose });
    const preview = resolveWebsitePreviewAssets(files, [selected], scope);
    expect(preview).toEqual({ "src/App.tsx": `<img src="${asset.url}"/>`, "src/style.css": `a{background:url(${asset.url})}` });
    expect(files["src/App.tsx"]).toContain(path);
    expect(selected.path).toBe(asset.path);
    expect(preview).not.toBe(files);
  });

  it("replaces stale cache queries without corrupting the signed token and preserves fragments", () => {
    expect(resolveWebsitePreviewAssets({ "src/style.css": `url(${path}?v=1#logo)` }, [asset], scope)["src/style.css"])
      .toBe(`url(${asset.url}#logo)`);
  });

  it.each([
    { purpose: "reference" }, { status: "pending" }, { status: "failed" }, { status: "deleting" }, { status: undefined },
    { client_id: assetId }, { project_id: assetId }, { path: `${clientId}/${projectId}/wrong.png` },
    { url: undefined }, { url: "javascript:alert(1)" }, { url: "http://storage.example.test/file" },
    { url: "https://user:pass@storage.example.test/file" }, { url: "https://storage.example.test/'onerror='alert(1)" },
    { url: "https://storage.example.test/${alert(1)}" },
  ] as Partial<WebsiteAsset>[]) ("never substitutes unsafe or unauthorized assets: %j", (patch) => {
    const files = { "src/App.tsx": `<img src="${path}"/>` };
    expect(resolveWebsitePreviewAssets(files, [{ ...asset, ...patch }], scope)).toEqual(files);
  });

  it("keeps unresolved and external references unchanged and accepts refreshed URLs", () => {
    const files = { "src/App.tsx": `['${path}', 'https://external.example.test${path}']` };
    expect(resolveWebsitePreviewAssets(files, [], scope)).toEqual(files);
    expect(resolveWebsitePreviewAssets(files, [{ ...asset, url: `${asset.url}2` }], scope)["src/App.tsx"])
      .toBe(`['${asset.url}2', 'https://external.example.test${path}']`);
  });
});


describe("preview asset wiring", () => {
  it("resolves uploaded logos in the Sandpack input and leaves saved sources permanent", () => {
    const source = { ...getStarterFiles(), "src/App.tsx": `<img src="${path}" />` };
    const preview = getSitePreviewFiles(source, [asset], scope);
    expect(JSON.stringify(preview["/src/App.tsx"])).toContain(asset.url);
    expect(source["src/App.tsx"]).toContain(path);
    const renewed = getSitePreviewFiles(source, [{ ...asset, url: "https://storage.example.test/renewed" }], scope);
    expect(JSON.stringify(renewed["/src/App.tsx"])).toContain("/renewed");
    expect(JSON.stringify(getSitePreviewFiles(source, [asset], { ...scope, client_id: "foreign" }))).not.toContain(asset.url);
  });
});
