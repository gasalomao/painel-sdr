import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

if (process.cwd() !== "/workspace" || process.getuid?.() === 0) throw new Error("QA requer microVM isolada e usuário studio.");
const started = Date.now();
// ponytail: six viewports share at most 40s; larger sites need an explicitly larger outer budget/template.
const budget = Number(process.env.SITE_STUDIO_RUNNER_BUDGET_MS ?? 40_000);
const deadline = started + (Number.isFinite(budget) ? Math.max(1000, Math.min(40_000, budget)) : 40_000);
let stage = "input";
let failureKind;
let diagnostics = [];
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

function sanitizeDiagnostic(text) {
  return text.slice(0, 4000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f​-‏‪-‮⁠-⁯]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:sk-|eyJ)[\w.-]+/g, "[redacted]")
    .replace(/(['"`])[^'"`]*\1/g, "[quoted]").slice(0, 300);
}

function diagnosticsFromLogs(text) {
  const clean = text.slice(0, 24_000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => {
    const location = line.match(/(?:src\/[\w./-]+|index\.html)\s*(?:\(\d+[, :]\d+\)|:\d+(?::\d+)?)/)?.[0];
    if (!location) return [];
    if (/error TS\d+|ERROR:|error:|Unexpected|Expected/i.test(line)) return [line.replace(/^.*?(?=(?:src\/|index\.html))/, "")];
    const nearby = lines.slice(Math.max(0, index - 3), index + 3).find((candidate) => /^(?:ERROR:|Error:|\[vite:|Transform failed|Unexpected|Expected)/i.test(candidate.trim()));
    return nearby ? [`${location}: ${nearby.trim()}`] : [];
  });
  return [...new Set(matches.map(sanitizeDiagnostic))].slice(0, 8);
}

function qaFailure(kind, message) {
  return Object.assign(new Error(message), { failure_kind: kind, stage });
}

function remaining(cap = 40_000) {
  const ms = Math.min(cap, deadline - Date.now());
  if (ms <= 0) throw qaFailure("timeout", `Tempo esgotado (${stage}).`);
  return ms;
}

async function bounded(operation, cap = 40_000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(qaFailure("timeout", `Tempo esgotado (${stage}).`)), remaining(cap));
    })]);
  } finally { clearTimeout(timer); }
}

async function command(args) {
  const ms = remaining();
  await new Promise((done, reject) => {
    const child = spawn("node", args, { cwd: root, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/studio", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(qaFailure("timeout", `Tempo esgotado (${stage}).`)); }, ms);
    const append = (data) => { output = (output + data.toString()).slice(-24_000); logs = (logs + data.toString()).slice(-24_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.once("error", () => { clearTimeout(timer); reject(qaFailure("infrastructure", "Compilador indisponível.")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return done();
      const found = diagnosticsFromLogs(output);
      reject(qaFailure(signal ? "infrastructure" : found.length ? "source" : "infrastructure", found.length ? found.join("\n") : "Compilador/template indisponível, sem diagnóstico de fonte."));
    });
  });
}

async function ready(page, width) {
  stage = "react";
  await page.waitForFunction(() => Boolean(document.querySelector("#root")?.children.length), null, { timeout: remaining(3000) });
  stage = "fonts";
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: remaining(2000) });
  stage = "images";
  // Full-page captures include lazy images below the fold. Scroll boundedly, then restore the viewport.
  const height = await bounded(page.evaluate(() => document.documentElement.scrollHeight), 1000);
  if (height > 16_000) throw qaFailure("source", "Página excede o limite de captura (16000px).");
  for (let y = 0; y < height; y += 800) {
    await bounded(page.evaluate((offset) => scrollTo(0, offset), y), 1000);
    await page.waitForFunction(() => [...document.images].filter((image) => {
      const rect = image.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
    }).every((image) => image.complete), null, { timeout: remaining(1500) });
  }
  await bounded(page.evaluate((offset) => scrollTo(0, offset), 0), 1000);
  await page.waitForFunction(() => [...document.images].filter((image) => image.getClientRects().length).every((image) => image.complete), null, { timeout: remaining(1500) });
  const broken = await bounded(page.evaluate(() => [...document.images].some((image) => image.getClientRects().length && image.complete && image.naturalWidth === 0)), 1000);
  if (broken) errors.push(`${width}px: Imagem quebrada.`);
  stage = "paint";
  await bounded(page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))), 1000);
}

let browser;
let server;
try {
  await bounded((async () => {
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
  stage = "typecheck";
  await command(["/opt/site-deps/node_modules/typescript/bin/tsc", "--noEmit"]);
  stage = "build";
  await command(["/opt/site-deps/node_modules/vite/bin/vite.js", "build"]);
  stage = "artifact";
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
  stage = "browser";
  browser = await chromium.launch({
    headless: true, chromiumSandbox: false, timeout: remaining(4000),
    // MicroVM + studio user remain the isolation boundary; preserve the installed template's browser flags.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  });
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
    stage = "navigation";
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded", timeout: remaining(4000) });
    await ready(page, width);
    stage = "render";
    const findings = await page.evaluate(() => {
      const issues = [];
      const named = (element) => Boolean(element.textContent?.trim() || element.getAttribute("aria-label")?.trim() || element.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim()) || element.querySelector("img[alt]")?.getAttribute("alt"));
      if (document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1) issues.push("Overflow horizontal.");
      if (document.body.innerText.trim().length < 40) issues.push("Página vazia ou incompleta.");
      if (!document.documentElement.lang || !document.title.trim() || !document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim()) issues.push("Metadados SEO ausentes.");
      if (document.querySelectorAll("h1").length !== 1 || !document.querySelector("main")) issues.push("Semântica main/h1 inválida.");
      if (/lorem ipsum|your company|placeholder|sua empresa aqui/i.test(document.body.innerText)) issues.push("Texto placeholder.");
      for (const image of document.images) {
        if (image.getClientRects().length && !image.complete) issues.push("Imagem pendente.");
        else if (image.getClientRects().length && image.naturalWidth === 0) issues.push("Imagem quebrada.");
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
    stage = "screenshot";
    if (width === 1440 || width === 390) screenshots[width === 1440 ? "desktop" : "mobile"] = `data:image/png;base64,${(await page.screenshot({ fullPage: true, animations: "disabled", timeout: remaining(2000) })).toString("base64")}`;
    await page.close();
  }
  })());
} catch (error) {
  failureKind = error?.failure_kind ?? (error?.name === "TimeoutError" ? "timeout" : ["react", "render", "paint"].includes(stage) ? "source" : "infrastructure");
  if (stage === "images" && failureKind === "timeout") errors.push("Imagem pendente; captura não confiável.");
  diagnostics = failureKind === "source" && ["typecheck", "build"].includes(stage) ? diagnosticsFromLogs(logs) : [];
  errors.push(diagnostics.length ? diagnostics.join("; ") : failureKind === "timeout" ? `Tempo esgotado (${stage}); QA incompleto.` :
    failureKind === "source" ? "Renderização reprovada." : `Infraestrutura/template indisponível (${stage}).`);
} finally {
  const unique = [...new Set(errors)].slice(0, 100).map(sanitizeDiagnostic);
  // Persist evidence before browser cleanup. The provider always kills the microVM.
  await writeFile("/workspace/result.json", JSON.stringify({ success: unique.length === 0, status: unique.length ? "failed" : "ready", logs: "", duration_ms: Date.now() - started, artifact, screenshots, errors: unique, warnings,
    qa: { passed: unique.length === 0, errors: unique, warnings, ...(unique.length ? { failure_kind: failureKind ?? "source", stage, diagnostics } : {}) } }));
  let timer;
  try {
    await Promise.race([Promise.allSettled([browser?.close(), server ? new Promise((done) => { server.closeAllConnections(); server.close(done); }) : undefined]), new Promise((done) => { timer = setTimeout(done, 1000); })]);
  } finally { clearTimeout(timer); }
  process.exit(0);
}
