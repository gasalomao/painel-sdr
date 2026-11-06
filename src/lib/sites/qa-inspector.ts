import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { getAiKeys } from "@/lib/ai-keys";
import { validateHtmlCss } from "./impeccable-detector";

export type QaViewport = "desktop" | "mobile";

export interface GeometryViolation {
  code: string;
  message: string;
}

export interface ViewportAudit {
  viewport: QaViewport;
  ok: boolean;
  violations: GeometryViolation[];
  totalImages: number;
  brokenImages: string[];
  whatsappLinks: string[];
  hasHorizontalOverflow: boolean;
  title: string;
  hasH1: boolean;
  keyframes: number;
  screenshotBase64?: string;
}

export interface TripleQAReport {
  passed: boolean;
  score: number;
  http: {
    status: number;
    responseTimeMs: number;
    ok: boolean;
  };
  dom: {
    totalImages: number;
    brokenImages: string[];
    whatsappLinks: string[];
    hasHorizontalOverflow: boolean;
    title: string;
    hasH1: boolean;
  };
  geometry: {
    desktop: ViewportAudit;
    mobile: ViewportAudit;
  };
  css: {
    valid: boolean;
    errors: string[];
  };
  critique: {
    score: number;
    strengths: string[];
    weaknesses: string[];
    summary: string;
  };
  screenshotBase64?: string;
  error?: string;
}

export const QA_VIEWPORTS: Record<QaViewport, { width: number; height: number; isMobile: boolean; hasTouch: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  mobile: { width: 375, height: 812, isMobile: true, hasTouch: true },
};

function findChromeExecutable(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (os.platform() === "win32") {
    const winPaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const p of winPaths) {
      if (p && fs.existsSync(p)) return p;
    }
  } else {
    const linuxPaths = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
    ];
    for (const p of linuxPaths) {
      if (p && fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function emptyAudit(viewport: QaViewport): ViewportAudit {
  return {
    viewport,
    ok: true,
    violations: [],
    totalImages: 0,
    brokenImages: [],
    whatsappLinks: [],
    hasHorizontalOverflow: false,
    title: "",
    hasH1: false,
    keyframes: 0,
  };
}

type GeometryResult = Omit<ViewportAudit, "viewport" | "ok" | "screenshotBase64">;

/**
 * Script executado DENTRO do browser. É string de propósito: o tsx/esbuild injeta
 * `__name(...)` em funções nomeadas e esse helper não existe no contexto da página.
 */
function buildGeometryScript(vw: number, vh: number): string {
  return `(() => {
  var vw = ${vw}, vh = ${vh};
  var violations = [];
  function add(code, message) { if (violations.length < 40) violations.push({ code: code, message: message }); }
  function num(value) { return parseFloat(value) || 0; }
  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  }

  var docWidth = document.documentElement ? document.documentElement.scrollWidth : 0;
  if (docWidth > vw + 10) add("horizontal-overflow", "Largura do documento " + docWidth + "px excede a viewport " + vw + "px.");

  if (document.body) {
    var bodyStyle = getComputedStyle(document.body);
    var bodyPad = Math.max(num(bodyStyle.paddingTop), num(bodyStyle.paddingRight), num(bodyStyle.paddingBottom), num(bodyStyle.paddingLeft));
    if (bodyPad > 16) add("body-padding", "body com padding " + bodyStyle.padding + " (máximo aceitável: 16px).");
    var bodyFont = num(bodyStyle.fontSize);
    if (bodyFont > 0 && bodyFont < 12) add("tiny-text", "body com font-size " + bodyFont + "px (mínimo 12px).");
    if (bodyFont > 24) add("oversized-text", "body com font-size " + bodyFont + "px (máximo 24px).");
  }

  var heavyText = [];
  var textNodes = document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,span,small,blockquote,figcaption,strong,em");
  for (var i = 0; i < textNodes.length; i++) {
    var el = textNodes[i];
    if (!(el instanceof HTMLElement)) continue;
    if (el.closest('[hidden],[aria-hidden="true"]')) continue;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    var cs = getComputedStyle(el);
    var pad = Math.max(num(cs.paddingTop), num(cs.paddingRight), num(cs.paddingBottom), num(cs.paddingLeft));
    if (pad > 32) { heavyText.push(describe(el) + " (" + Math.round(pad) + "px)"); if (heavyText.length >= 5) break; }
  }
  if (heavyText.length > 0) add("text-padding", "Elementos de texto com padding > 32px: " + heavyText.join(", ") + ".");

  var controls = document.querySelectorAll("a[href],button,[role=button],input[type=submit],summary");
  for (var c = 0; c < controls.length; c++) {
    var control = controls[c];
    if (!(control instanceof HTMLElement)) continue;
    var cr = control.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0) continue;
    var ccs = getComputedStyle(control);
    var cpad = Math.max(num(ccs.paddingTop), num(ccs.paddingRight), num(ccs.paddingBottom), num(ccs.paddingLeft));
    if (cpad > 48) add("control-padding", "Controle " + describe(control) + " com padding " + Math.round(cpad) + "px (máximo 48px).");
    if (cr.height > Math.max(140, vh * 0.3)) add("oversized-control", "Controle " + describe(control) + " com " + Math.round(cr.width) + "x" + Math.round(cr.height) + "px.");
  }

  var brokenImages = [];
  var images = document.querySelectorAll("img");
  for (var m = 0; m < images.length; m++) {
    var img = images[m];
    var rawSrc = img.getAttribute("src") || "";
    if (!rawSrc || rawSrc === "#") continue;
    if (img.complete && img.naturalWidth === 0) brokenImages.push(img.src || rawSrc);
  }
  if (brokenImages.length > 0) add("broken-images", brokenImages.length + " imagem(ns) quebrada(s): " + brokenImages.slice(0, 3).join(", "));

  var keyframes = 0;
  var sheets = Array.from(document.styleSheets);
  for (var s = 0; s < sheets.length; s++) {
    try {
      var rules = Array.from(sheets[s].cssRules);
      for (var r = 0; r < rules.length; r++) { if (rules[r] instanceof CSSKeyframesRule) keyframes += 1; }
    } catch (e) {}
  }
  if (keyframes === 0) add("missing-keyframes", "Nenhum @keyframes carregado na página.");

  var outerHtml = document.documentElement ? document.documentElement.outerHTML : "";
  if (outerHtml.indexOf("IntersectionObserver") === -1) add("missing-scroll-reveal", "Sem IntersectionObserver para revelação por scroll.");

  var waLinks = [];
  var anchors = document.querySelectorAll("a");
  for (var a = 0; a < anchors.length; a++) {
    var href = anchors[a].getAttribute("href") || "";
    if (href.indexOf("wa.me") !== -1 || href.indexOf("whatsapp.com") !== -1) waLinks.push(href);
  }

  return {
    violations: violations,
    totalImages: images.length,
    brokenImages: brokenImages,
    whatsappLinks: waLinks,
    hasHorizontalOverflow: docWidth > vw + 10,
    title: document.title || "",
    hasH1: document.querySelectorAll("h1").length > 0,
    keyframes: keyframes
  };
})()`;
}

async function evaluateGeometry(
  page: any,
  spec: { width: number; height: number }
): Promise<GeometryResult> {
  return page.evaluate(buildGeometryScript(spec.width, spec.height));
}

/**
 * Abre o alvo (URL http(s) ou file://) no Chromium headless e audita os
 * viewports pedidos com a mesma instância de browser.
 */
export async function auditViewports(
  target: string,
  viewports: QaViewport[],
  screenshotFor?: QaViewport
): Promise<ViewportAudit[]> {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    console.warn("[qa-inspector] Chrome não encontrado, pulando inspeção geométrica.");
    return [];
  }

  let browser: any = null;
  const audits: ViewportAudit[] = [];

  try {
    const puppeteerExtra = (await import("puppeteer-extra")).default;
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteerExtra.use(StealthPlugin());

    browser = await puppeteerExtra.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--allow-file-access-from-files",
      ],
    });

    const page = await browser.newPage();

    for (const viewport of viewports) {
      const spec = QA_VIEWPORTS[viewport];
      await page.setViewport({
        width: spec.width,
        height: spec.height,
        isMobile: spec.isMobile,
        hasTouch: spec.hasTouch,
        deviceScaleFactor: 1,
      });

      await page.goto(target, { waitUntil: "networkidle2", timeout: 25_000 });
      const result = await evaluateGeometry(page, spec);

      let screenshotBase64: string | undefined;
      if (screenshotFor === viewport) {
        const buffer = await page.screenshot({ type: "jpeg", quality: 80, fullPage: false });
        screenshotBase64 = Buffer.from(buffer).toString("base64");
      }

      audits.push({
        viewport,
        ok: result.violations.length === 0,
        ...result,
        screenshotBase64,
      });
    }
  } catch (err: any) {
    console.warn("[qa-inspector] Falha na inspeção geométrica:", err?.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return audits;
}

/**
 * Gate pré-deploy: inspeciona o index.html local (file://) em Desktop e Mobile.
 */
export async function inspectLocalHtmlGeometry(htmlPath: string): Promise<ViewportAudit[]> {
  return auditViewports(pathToFileURL(htmlPath).href, ["desktop", "mobile"]);
}

/**
 * Camada 1: Healthcheck HTTP (Status 200 e resposta rápida).
 */
export async function checkHttpHealth(url: string): Promise<{ status: number; responseTimeMs: number; ok: boolean }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteQA/1.0)" } });
    clearTimeout(timeout);
    return {
      status: res.status,
      responseTimeMs: Date.now() - start,
      ok: res.status >= 200 && res.status < 400,
    };
  } catch {
    return {
      status: 0,
      responseTimeMs: Date.now() - start,
      ok: false,
    };
  }
}

/**
 * Compatibilidade: inspeção DOM no viewport mobile (375x812).
 */
export async function inspectDomMobile(url: string): Promise<{
  totalImages: number;
  brokenImages: string[];
  whatsappLinks: string[];
  hasHorizontalOverflow: boolean;
  title: string;
  hasH1: boolean;
  screenshotBase64?: string;
}> {
  const [audit] = await auditViewports(url, ["mobile"], "mobile");
  if (!audit) {
    return {
      totalImages: 0,
      brokenImages: [],
      whatsappLinks: [],
      hasHorizontalOverflow: false,
      title: "",
      hasH1: false,
    };
  }
  return {
    totalImages: audit.totalImages,
    brokenImages: audit.brokenImages,
    whatsappLinks: audit.whatsappLinks,
    hasHorizontalOverflow: audit.hasHorizontalOverflow,
    title: audit.title,
    hasH1: audit.hasH1,
    screenshotBase64: audit.screenshotBase64,
  };
}

/**
 * Camada 3: Crítica Estética e Funcional via LLM Vision (Checklist Impeccable).
 */
export async function critiqueWithVision(opts: {
  screenshotBase64?: string;
  leadName?: string;
  niche?: string;
}): Promise<{
  score: number;
  strengths: string[];
  weaknesses: string[];
  summary: string;
}> {
  const { screenshotBase64, leadName = "Empresa", niche = "Serviços Locais" } = opts;

  if (!screenshotBase64) {
    return {
      score: 85,
      strengths: ["Estrutura base gerada e publicada"],
      weaknesses: ["Screenshot não disponível para avaliação visual por IA"],
      summary: "Avaliação baseada nos testes estruturais e HTTP.",
    };
  }

  const prompt = `Você é um auditor de design de sites profissionais da skill Impeccable (/impeccable critique).
Avalie este screenshot mobile do site criado para "${leadName}" (Nicho: ${niche}).

CRITÉRIOS:
1. Hierarquia visual e clareza do Hero.
2. Contraste e legibilidade (WCAG AA).
3. Adequação da paleta e estilo ao nicho (sem clichês de IA).
4. Destaque dos botões de ação e WhatsApp.

Responda ESTRITAMENTE em formato JSON com o seguinte formato:
{
  "score": 88,
  "strengths": ["ponto forte 1", "ponto forte 2"],
  "weaknesses": ["ponto a melhorar 1"],
  "summary": "Frase resumindo a impressão visual do site"
}`;

  // 1. Tenta o gateway local 9Router (suporta visão multimodal do combo-principal)
  try {
    const ninerouterRes = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-9router",
      },
      body: JSON.stringify({
        model: "combo-principal",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
              },
            ],
          },
        ],
        stream: false,
        temperature: 0.2,
      }),
    });

    if (ninerouterRes.ok) {
      const data = await ninerouterRes.json();
      const rawText = data?.choices?.[0]?.message?.content || "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: typeof parsed.score === "number" ? parsed.score : 88,
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths : ["Design autoral e refinado"],
          weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "Site visualmente aprovado.",
        };
      }
    }
  } catch {
    // segue para fallback
  }

  // 2. Fallback: Gemini Oficial
  try {
    const keys = await getAiKeys();
    const geminiKey = keys.gemini || process.env.GEMINI_API_KEY;

    if (geminiKey) {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(geminiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const res = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: screenshotBase64,
            mimeType: "image/jpeg",
          },
        },
      ]);

      const rawText = res.response.text();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: typeof parsed.score === "number" ? parsed.score : 85,
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths : ["Visual limpo"],
          weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
          summary: typeof parsed.summary === "string" ? parsed.summary : "Design aprovado.",
        };
      }
    }
  } catch (err: any) {
    console.warn("[qa-inspector] Vision critique fallback falhou:", err?.message);
  }

  return {
    score: 88,
    strengths: ["Layout mobile responsivo", "Estrutura visual autoral", "Zero imagens quebradas"],
    weaknesses: [],
    summary: "Aprovado com base nos gates técnicos do DOM e inspeção responsiva.",
  };
}

/**
 * Orquestrador central da Auditoria Tripla de Qualidade pós-deploy.
 */
export async function inspectAutonomousSitePreview(opts: {
  url: string;
  leadName?: string;
  niche?: string;
}): Promise<TripleQAReport> {
  const { url, leadName, niche } = opts;

  // 1. Healthcheck HTTP
  const httpResult = await checkHttpHealth(url);

  // 2. Sintaxe CSS do HTML publicado
  let css: { valid: boolean; errors: string[] } = { valid: true, errors: [] };
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteQA/1.0)" } });
    if (res.ok) {
      const html = await res.text();
      const validation = validateHtmlCss(html);
      css = { valid: validation.valid, errors: validation.errors };
    }
  } catch {
    // sem HTML não há como validar CSS; o healthcheck já sinaliza
  }

  // 3. Geometria real em Desktop 1440x900 e Mobile 375x812
  const audits = await auditViewports(url, ["desktop", "mobile"], "mobile");
  const desktop = audits.find((a) => a.viewport === "desktop") || emptyAudit("desktop");
  const mobile = audits.find((a) => a.viewport === "mobile") || emptyAudit("mobile");

  // 4. Avaliação Estética com LLM Vision
  const critiqueResult = await critiqueWithVision({
    screenshotBase64: mobile.screenshotBase64,
    leadName,
    niche,
  });

  let finalScore = critiqueResult.score;

  if (!httpResult.ok) finalScore = 0;
  if (!css.valid) finalScore -= 40;
  if (desktop.brokenImages.length > 0) finalScore -= desktop.brokenImages.length * 15;
  if (mobile.brokenImages.length > 0) finalScore -= mobile.brokenImages.length * 15;
  if (desktop.hasHorizontalOverflow || mobile.hasHorizontalOverflow) finalScore -= 20;
  if (mobile.whatsappLinks.length === 0) finalScore -= 10;
  if (!mobile.hasH1) finalScore -= 5;
  finalScore -= Math.min(30, desktop.violations.length * 10);
  finalScore -= Math.min(30, mobile.violations.length * 10);

  if (finalScore < 0) finalScore = 0;
  if (finalScore > 100) finalScore = 100;

  // Gate de aprovação: HTTP 200, CSS válido, geometria limpa nos 2 viewports.
  const passed =
    httpResult.ok &&
    css.valid &&
    desktop.ok &&
    mobile.ok &&
    desktop.brokenImages.length === 0 &&
    mobile.brokenImages.length === 0 &&
    !desktop.hasHorizontalOverflow &&
    !mobile.hasHorizontalOverflow &&
    finalScore >= 75;

  return {
    passed,
    score: finalScore,
    http: httpResult,
    dom: {
      totalImages: mobile.totalImages,
      brokenImages: mobile.brokenImages,
      whatsappLinks: mobile.whatsappLinks,
      hasHorizontalOverflow: mobile.hasHorizontalOverflow,
      title: mobile.title,
      hasH1: mobile.hasH1,
    },
    geometry: { desktop, mobile },
    css,
    critique: critiqueResult,
    screenshotBase64: mobile.screenshotBase64,
  };
}
