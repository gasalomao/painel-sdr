import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

if (process.cwd() !== "/workspace" || process.getuid?.() === 0) throw new Error("QA requer microVM isolada e usuário studio.");
const root = "/workspace/site";
const dist = `${root}/dist`;
const errors = [];
const warnings = [];
let logs = "";
const screenshots = {};
const artifact = {};
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2" };

function safePath(path) {
  if (typeof path !== "string" || path.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || path.startsWith("/") || /(?:^|\/)(?:node_modules|_worker\.js|_headers|_redirects|functions)(?:\/|$)/i.test(path)) throw new Error("Caminho inseguro.");
  return path;
}

async function guard(path, parent) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !(await realpath(path)).startsWith(`${parent}${sep}`)) throw new Error("Symlink ou escape de diretório.");
  return stat;
}

async function command(args) {
  await new Promise((done, reject) => {
    const child = spawn("node", args, { cwd: root, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/studio", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    const append = (data) => { logs = (logs + data.toString()).slice(-24_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? done() : reject(new Error("Typecheck/build falhou.")));
  });
}

let browser;
let server;
try {
  const { files, binaries } = JSON.parse(await readFile("/workspace/input.json", "utf8"));
  const fixed = JSON.parse(await readFile("/opt/site-studio/fixed.json", "utf8"));
  if (!files || Object.keys(files).length > 200 || Object.keys(binaries).length > 100) throw new Error("Limite de arquivos excedido.");
  await mkdir(root);
  await symlink("/opt/site-deps/node_modules", `${root}/node_modules`, "dir");
  for (const [path, expected] of Object.entries(fixed)) {
    if (files[path] !== expected) throw new Error("Template desatualizado ou configuração alterada.");
  }
  let inputBytes = 0;
  for (const [path, content] of Object.entries(files)) {
    safePath(path);
    if (typeof content !== "string" || (path !== "index.html" && !path.startsWith("src/") && !path.startsWith("public/") && fixed[path] !== content) || path.startsWith("public/assets/")) throw new Error("Arquivo não autorizado.");
    inputBytes += Buffer.byteLength(content);
    if (inputBytes > 2 * 1024 * 1024) throw new Error("Fontes excedem o limite.");
    const target = join(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
    await guard(target, root);
  }
  for (const [path, content] of Object.entries(binaries)) {
    safePath(path);
    if (!/^public\/assets\/[a-f0-9-]{36}\.(png|jpg|webp|gif|avif)$/i.test(path)) throw new Error("Asset inválido.");
    const bytes = Buffer.from(content, "base64");
    inputBytes += bytes.length;
    if (inputBytes > 42 * 1024 * 1024) throw new Error("Assets excedem o limite.");
    const target = join(root, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    await guard(target, root);
  }
  await command(["/opt/site-deps/node_modules/typescript/bin/tsc", "--noEmit"]);
  await command(["/opt/site-deps/node_modules/vite/bin/vite.js", "build"]);
  let total = 0;
  async function collect(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const path = safePath(`${prefix}${name}`);
      const file = join(directory, name);
      const stat = await guard(file, dist);
      if (stat.isDirectory()) await collect(file, `${path}/`);
      else if (stat.isFile()) {
        if (stat.size > 20 * 1024 * 1024 || (total += stat.size) > 40 * 1024 * 1024 || Object.keys(artifact).length >= 500) throw new Error("Artefato excede o limite.");
        const type = mime[extname(path)];
        if (!type || path.endsWith(".map")) throw new Error("Artefato não permitido.");
        artifact[`/${path}`] = { content: (await readFile(file)).toString("base64"), mime: type };
      } else throw new Error("Artefato não regular.");
    }
  }
  await collect(dist);
  if (!artifact["/index.html"]) throw new Error("index.html ausente.");
  server = createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1:4173").pathname); } catch { response.writeHead(400).end(); return; }
    const file = artifact[pathname === "/" ? "/index.html" : pathname];
    if (request.method !== "GET" || !file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": file.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
    response.end(Buffer.from(file.content, "base64"));
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(4173, "127.0.0.1", done); });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173" && route.request().method() === "GET") return route.continue();
    errors.push("Recurso externo bloqueado durante renderização.");
    return route.abort();
  });
  await context.routeWebSocket("**/*", (socket) => socket.close());
  for (const width of [1440, 390, 320, 375, 768, 1024]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 1000 });
    page.on("pageerror", () => errors.push(`Erro JavaScript em ${width}px.`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`Erro de console em ${width}px.`); });
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`Recurso ausente em ${width}px.`); });
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle", timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    const findings = await page.evaluate(() => {
      const issues = [];
      const named = (element) => Boolean(element.textContent?.trim() || element.getAttribute("aria-label")?.trim() || element.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim()) || element.querySelector("img[alt]")?.getAttribute("alt"));
      if (document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1) issues.push("Overflow horizontal.");
      if (document.body.innerText.trim().length < 40) issues.push("Página vazia ou incompleta.");
      if (!document.documentElement.lang || !document.title.trim() || !document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim()) issues.push("Metadados SEO ausentes.");
      if (document.querySelectorAll("h1").length !== 1 || !document.querySelector("main")) issues.push("Semântica main/h1 inválida.");
      if (/lorem ipsum|your company|placeholder|sua empresa aqui/i.test(document.body.innerText)) issues.push("Texto placeholder.");
      for (const image of document.images) {
        if (!image.complete || image.naturalWidth === 0) issues.push("Imagem ausente.");
        if (!image.hasAttribute("alt")) issues.push("Imagem sem alt.");
      }
      for (const link of document.querySelectorAll("a")) {
        const href = link.getAttribute("href")?.trim();
        if (!href || href === "#" || /^(javascript:|data:|https?:\/\/(?:www\.)?example\.(?:com|org))/i.test(href)) issues.push("Link placeholder ou inseguro.");
        if (href?.startsWith("#") && href.length > 1 && !document.getElementById(href.slice(1))) issues.push("Âncora inexistente.");
        if (!named(link)) issues.push("Link sem nome acessível.");
      }
      for (const button of document.querySelectorAll("button")) if (!named(button)) issues.push("Botão sem nome acessível.");
      for (const input of document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),select,textarea')) {
        if (!input.labels?.length && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) issues.push("Campo sem label.");
      }
      const internalLinks = [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((href) => href.startsWith(location.origin) && !href.includes("#"));
      return { issues, internalLinks };
    });
    errors.push(...findings.issues.map((issue) => `${width}px: ${issue}`));
    for (const href of new Set(findings.internalLinks)) {
      const pathname = new URL(href).pathname;
      if (pathname !== "/" && !artifact[pathname]) errors.push(`Link interno sem destino em ${width}px.`);
    }
    if (width === 1440 || width === 390) screenshots[width === 1440 ? "desktop" : "mobile"] = `data:image/png;base64,${(await page.screenshot({ fullPage: true, animations: "disabled", timeout: 10_000 })).toString("base64")}`;
    await page.close();
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message.slice(0, 500) : "QA isolado falhou.");
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  const unique = [...new Set(errors)];
  await writeFile("/workspace/result.json", JSON.stringify({ success: unique.length === 0, status: unique.length ? "failed" : "ready", logs, duration_ms: 0, artifact, screenshots, errors: unique, warnings, qa: { passed: unique.length === 0, errors: unique, warnings } }));
}
