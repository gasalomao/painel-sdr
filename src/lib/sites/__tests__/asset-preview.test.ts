import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
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
    runInNewContext(code(preview, "/index.tsx"), { DOMParser, document, require: (path: string) => { expect(path).toBe("./src/main.tsx"); expect(mounted && removedScripts).toBe(true); expect(document.documentElement.lang).toBe("pt-BR"); expect(document.title).toBe('Ateliê "Horizonte"'); } });
    expect(parsed).toBe(html);
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
