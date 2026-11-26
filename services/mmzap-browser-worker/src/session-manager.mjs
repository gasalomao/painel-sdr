import { chromium } from "playwright";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createAuthenticatedProxyTunnel } from "./proxy-tunnel.mjs";

const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.env.DATA_DIR || "/data");
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
const EXTENSION_DIR = path.join(DATA_DIR, "extensions", "mmzap");
const DEFAULT_EXTENSION_DIR = path.resolve(
  process.env.DEFAULT_EXTENSION_DIR || "/opt/mmzap-extension"
);
const MAX_CONCURRENT = Math.max(
  1,
  Math.min(3, Number(process.env.MAX_CONCURRENT_BROWSERS || 2) || 2)
);
const MAX_RSS_MB = Math.max(256, Number(process.env.MAX_RSS_MB || 550) || 550);
const QR_TIMEOUT_MS = 3 * 60 * 1000;

const sessions = new Map();

export function sanitizeInstanceName(name) {
  const safe = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error("Nome de instância inválido");
  }
  return safe;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function getExtensionStatus() {
  const candidates = [
    { dir: EXTENSION_DIR, source: "override" },
    { dir: DEFAULT_EXTENSION_DIR, source: "builtin" },
  ];

  for (const cand of candidates) {
    const manifestPath = path.join(cand.dir, "manifest.json");
    if (!(await fileExists(manifestPath))) continue;
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      const defaultPopup =
        manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
      return {
        installed: true,
        name: String(manifest.name || "MMZap"),
        version: String(manifest.version || ""),
        defaultPopup: defaultPopup ? String(defaultPopup).replace(/^\/+/, "") : null,
        dir: cand.dir,
        source: cand.source,
      };
    } catch {
      /* tenta próximo candidato */
    }
  }

  return {
    installed: false,
    name: null,
    version: null,
    defaultPopup: null,
    dir: EXTENSION_DIR,
    source: null,
  };
}

async function cleanStaleLocks(profileDir) {
  for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      await fs.rm(path.join(profileDir, lockName), { force: true });
    } catch {}
  }
}

async function isSetupDone(profileDir) {
  return fileExists(path.join(profileDir, ".mmzap-setup-done"));
}

export async function markSetupDone(instanceName) {
  const safe = sanitizeInstanceName(instanceName);
  const profileDir = path.join(PROFILES_DIR, safe);
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, ".mmzap-setup-done"), new Date().toISOString(), "utf8");
  const current = sessions.get(safe);
  if (current) {
    current.needsExtensionSetup = false;
    current.updatedAt = new Date().toISOString();
  }
  return { ok: true, instanceName: safe, needsExtensionSetup: false };
}

async function readLinuxProcessTreeRssMb(pid) {
  if (!pid || process.platform !== "linux") return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const match = raw.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return Math.round((Number(match[1]) / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

async function detectWhatsAppLoggedIn(page) {
  try {
    const loggedIn = await page.evaluate(() => {
      return Boolean(
        document.querySelector('[data-testid="chat-list"]') ||
          document.querySelector("#pane-side") ||
          document.querySelector('[aria-label="Lista de conversas"]') ||
          document.querySelector('[aria-label="Chat list"]')
      );
    });
    return Boolean(loggedIn);
  } catch {
    return false;
  }
}

async function inspectMmzapDom(page) {
  try {
    return await page.evaluate(() => {
      const chip = document.querySelector("#mmzap-chip");
      if (!chip) {
        return { mmzapUiDetected: false, mmzapChipState: null, mmzapStatusLabel: null };
      }
      const cls = chip.className || "";
      const chipState = cls.includes("is-error")
        ? "is-error"
        : cls.includes("is-off")
          ? "is-off"
          : cls.includes("is-on")
            ? "is-on"
            : "connecting";
      const labelEl = chip.querySelector(".mmzap-chip-label");
      const label = labelEl ? String(labelEl.textContent || "").trim() : "";
      return {
        mmzapUiDetected: true,
        mmzapChipState: chipState,
        mmzapStatusLabel: label || null,
      };
    });
  } catch {
    return { mmzapUiDetected: false, mmzapChipState: null, mmzapStatusLabel: null };
  }
}

async function ensureMmzapInjected(session) {
  if (!session || session.ensuringMmzap) return;
  session.ensuringMmzap = true;
  try {
    let info = await inspectMmzapDom(session.page);
    if (info.mmzapUiDetected) {
      session.mmzapUiDetected = true;
      session.mmzapChipState = info.mmzapChipState;
      session.mmzapStatusLabel = info.mmzapStatusLabel;
      session.updatedAt = new Date().toISOString();
      return;
    }

    // Countera o limite de 10x2s (20s) do content.js da MMZap quando veio da tela de QR ou proxy lenta
    await session.page
      .reload({ waitUntil: "domcontentloaded", timeout: 35_000 })
      .catch(() => {});

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      info = await inspectMmzapDom(session.page);
      if (info.mmzapUiDetected) {
        break;
      }
    }

    session.mmzapUiDetected = info.mmzapUiDetected;
    session.mmzapChipState = info.mmzapChipState;
    session.mmzapStatusLabel = info.mmzapStatusLabel;
    session.updatedAt = new Date().toISOString();
  } finally {
    session.ensuringMmzap = false;
  }
}

async function captureQrDataUrl(page) {
  try {
    const qrLoc = page
      .locator('[data-ref] canvas, canvas[aria-label*="Scan"], [data-testid="qrcode"] canvas, canvas')
      .first();
    const visible = await qrLoc.isVisible().catch(() => false);
    if (visible) {
      const box = await qrLoc.boundingBox().catch(() => null);
      if (box && box.width >= 100 && box.height >= 100) {
        const buf = await qrLoc.screenshot({ type: "png" });
        return `data:image/png;base64,${buf.toString("base64")}`;
      }
    }
    const full = await page.screenshot({ type: "png" });
    return `data:image/png;base64,${full.toString("base64")}`;
  } catch {
    return null;
  }
}

async function launchBrowserSession({ safeName, clientId, mode, proxy, shiftDurationMinutes }) {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const profileDir = path.join(PROFILES_DIR, safeName);
  await fs.mkdir(profileDir, { recursive: true });
  await cleanStaleLocks(profileDir);

  const extStatus = await getExtensionStatus();
  const setupCompleted = await isSetupDone(profileDir);
  const requiresManualSetup = Boolean(extStatus.installed && extStatus.defaultPopup && !setupCompleted);

  if (mode === "start" && requiresManualSetup) {
    return {
      ok: false,
      needsExtensionSetup: true,
      error: "Configure a extensão MMZap pela 1ª vez antes de iniciar o turno.",
    };
  }

  let tunnel = null;
  if (proxy && proxy.server) {
    tunnel = await createAuthenticatedProxyTunnel(proxy);
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--lang=pt-BR",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--js-flags=--max-old-space-size=256",
  ];

  if (extStatus.installed && extStatus.dir) {
    launchArgs.push(`--disable-extensions-except=${extStatus.dir}`);
    launchArgs.push(`--load-extension=${extStatus.dir}`);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: launchArgs,
      viewport: { width: 1024, height: 720 },
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      proxy: tunnel ? { server: tunnel.localUrl } : undefined,
      ignoreDefaultArgs: ["--disable-extensions"],
    });
  } catch (err) {
    if (tunnel) await tunnel.close().catch(() => {});
    throw err;
  }

  // Economia agressiva de RAM (VPS 4 GB): bloqueia vídeo/áudio pesado mantendo DOM 100% íntegro
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (type === "media" || /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(url)) {
      return route.abort().catch(() => {});
    }
    return route.continue().catch(() => {});
  });

  const existingPages = context.pages();
  const page = existingPages[0] || (await context.newPage());
  for (let i = 1; i < existingPages.length; i++) {
    await existingPages[i].close().catch(() => {});
  }

  // Evita aba duplicada aberta pelo chrome.runtime.onInstalled do MMZap (poupa RAM)
  context.on("page", (extraPage) => {
    if (extraPage !== page) {
      void extraPage.close().catch(() => {});
    }
  });

  const session = {
    instanceName: safeName,
    clientId: String(clientId || ""),
    status: mode === "pair" ? "qr_pending" : mode === "setup" ? "setup" : "running",
    context,
    page,
    tunnel,
    proxyIp: proxy?.sourceHost || tunnel?.upstreamHost || null,
    qrCodeBase64: null,
    needsExtensionSetup: requiresManualSetup,
    shiftDurationMinutes: Math.max(5, Number(shiftDurationMinutes || 40)),
    mmzapUiDetected: false,
    mmzapChipState: null,
    mmzapStatusLabel: null,
    ensuringMmzap: false,
    startedAtMs: Date.now(),
    updatedAt: new Date().toISOString(),
    lastError: null,
    timer: null,
    mode,
  };

  sessions.set(safeName, session);

  const timeoutMs =
    mode === "pair"
      ? QR_TIMEOUT_MS
      : mode === "setup"
        ? 10 * 60 * 1000
        : Math.max(5, Number(shiftDurationMinutes || 45)) * 60 * 1000;

  session.timer = setTimeout(() => {
    void stopSession(safeName, mode === "pair" ? "qr_timeout" : "shift_timeout");
  }, timeoutMs);

  context.on("close", () => {
    if (sessions.get(safeName) === session) {
      if (session.timer) clearTimeout(session.timer);
      sessions.delete(safeName);
      if (session.tunnel) {
        void session.tunnel.close().catch(() => {});
      }
    }
  });

  try {
    await page.goto("https://web.whatsapp.com", {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });
  } catch (err) {
    session.lastError = err instanceof Error ? err.message : String(err);
  }

  return { ok: true, session };
}

export async function startPairingSession({
  instanceName,
  clientId,
  proxy,
  shiftDurationMinutes,
}) {
  const safeName = sanitizeInstanceName(instanceName);
  const existing = sessions.get(safeName);
  if (existing && existing.status !== "qr_pending") {
    await stopSession(safeName, "re_pair");
  } else if (existing) {
    return getPairingQr(safeName);
  }

  if (sessions.size >= MAX_CONCURRENT) {
    return {
      statusCode: 429,
      body: {
        error: `Limite de ${MAX_CONCURRENT} browser(s) simultâneo(s) atingido na VPS. Aguarde um turno encerrar.`,
        maxConcurrent: MAX_CONCURRENT,
      },
    };
  }

  const launched = await launchBrowserSession({
    safeName,
    clientId,
    mode: "pair",
    proxy,
    shiftDurationMinutes: Number(shiftDurationMinutes || 40),
  });

  if (!launched.ok) {
    return { statusCode: 400, body: launched };
  }

  await new Promise((r) => setTimeout(r, 2500));
  return getPairingQr(safeName);
}

export async function getPairingQr(instanceName) {
  const safeName = sanitizeInstanceName(instanceName);
  const session = sessions.get(safeName);
  if (!session) {
    return {
      statusCode: 200,
      body: {
        instanceName: safeName,
        status: "idle",
        qrCodeBase64: null,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (session.status === "running") {
    const info = await inspectMmzapDom(session.page);
    session.mmzapUiDetected = info.mmzapUiDetected;
    session.mmzapChipState = info.mmzapChipState;
    session.mmzapStatusLabel = info.mmzapStatusLabel;
    return {
      statusCode: 200,
      body: {
        instanceName: safeName,
        status: "running",
        needsExtensionSetup: false,
        mmzapUiDetected: session.mmzapUiDetected,
        mmzapChipState: session.mmzapChipState,
        mmzapStatusLabel: session.mmzapStatusLabel,
        proxyIp: session.proxyIp,
        qrCodeBase64: null,
        updatedAt: session.updatedAt,
      },
    };
  }

  const loggedIn = await detectWhatsAppLoggedIn(session.page);
  if (loggedIn) {
    session.qrCodeBase64 = null;
    session.updatedAt = new Date().toISOString();
    if (session.needsExtensionSetup) {
      session.status = "needs_extension_setup";
      session.mode = "setup";
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        void stopSession(safeName, "setup_timeout");
      }, 10 * 60 * 1000);
    } else {
      // Mantém o Chromium logado aberto e inicia o 1º turno MMZap automaticamente,
      // recarregando a aba para garantir que o content.js da extensão injete (janela de 20s).
      session.mode = "start";
      session.status = "running";
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        void stopSession(safeName, "shift_timeout");
      }, Math.max(5, session.shiftDurationMinutes || 40) * 60 * 1000);
      await ensureMmzapInjected(session);
    }
    return {
      statusCode: 200,
      body: {
        instanceName: safeName,
        status: session.status,
        needsExtensionSetup: session.needsExtensionSetup,
        mmzapUiDetected: session.mmzapUiDetected,
        mmzapChipState: session.mmzapChipState,
        mmzapStatusLabel: session.mmzapStatusLabel,
        proxyIp: session.proxyIp,
        qrCodeBase64: null,
        updatedAt: session.updatedAt,
      },
    };
  }

  const qr = await captureQrDataUrl(session.page);
  session.qrCodeBase64 = qr;
  session.updatedAt = new Date().toISOString();

  return {
    statusCode: 200,
    body: {
      instanceName: safeName,
      status: "qr_pending",
      needsExtensionSetup: session.needsExtensionSetup,
      proxyIp: session.proxyIp,
      qrCodeBase64: qr,
      updatedAt: session.updatedAt,
    },
  };
}

export async function openSetupSession({ instanceName, clientId, proxy, setupUrl }) {
  const safeName = sanitizeInstanceName(instanceName);
  const existing = sessions.get(safeName);
  if (
    existing &&
    existing.status !== "running" &&
    existing.status !== "setup" &&
    existing.status !== "needs_extension_setup"
  ) {
    await stopSession(safeName, "enter_setup");
  }

  if (!sessions.has(safeName)) {
    if (sessions.size >= MAX_CONCURRENT) {
      return {
        statusCode: 429,
        body: {
          error: `Limite de ${MAX_CONCURRENT} browser(s) simultâneo(s) atingido na VPS.`,
          maxConcurrent: MAX_CONCURRENT,
        },
      };
    }

    const launched = await launchBrowserSession({
      safeName,
      clientId,
      mode: "setup",
      proxy,
      shiftDurationMinutes: 10,
    });
    if (!launched.ok) {
      return { statusCode: 400, body: launched };
    }
  }

  const session = sessions.get(safeName);
  const keepRunning = session.status === "running";
  if (!keepRunning) {
    session.status = "setup";
    session.mode = "setup";
  }
  session.updatedAt = new Date().toISOString();

  if (setupUrl) {
    await session.page.goto(setupUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  } else if (!keepRunning) {
    const extStatus = await getExtensionStatus();
    const serviceWorkers = session.context.serviceWorkers();
    const bgPages = session.context.backgroundPages();
    const firstUrl = serviceWorkers[0]?.url() || bgPages[0]?.url() || "";
    const extMatch = firstUrl.match(/^chrome-extension:\/\/([^/]+)/);

    if (extStatus.defaultPopup && extMatch?.[1]) {
      const extBase = `chrome-extension://${extMatch[1]}`;
      await session.page.goto(`${extBase}/${extStatus.defaultPopup}`, { timeout: 8000 }).catch(async () => {
        await session.page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
      });
    } else {
      const curUrl = session.page.url() || "";
      if (!curUrl.startsWith("https://web.whatsapp.com")) {
        await session.page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const info = await inspectMmzapDom(session.page);
  session.mmzapUiDetected = info.mmzapUiDetected;
  session.mmzapChipState = info.mmzapChipState;
  session.mmzapStatusLabel = info.mmzapStatusLabel;

  const shot = await session.page.screenshot({ type: "png" }).catch(() => null);
  return {
    statusCode: 200,
    body: {
      instanceName: safeName,
      status: session.status,
      mmzapUiDetected: session.mmzapUiDetected,
      mmzapChipState: session.mmzapChipState,
      mmzapStatusLabel: session.mmzapStatusLabel,
      proxyIp: session.proxyIp,
      screenshotBase64: shot ? `data:image/png;base64,${shot.toString("base64")}` : null,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function getSessionScreenshot(instanceName) {
  const safeName = sanitizeInstanceName(instanceName);
  const session = sessions.get(safeName);
  if (!session) {
    return { statusCode: 404, body: { error: "Sessão não está aberta" } };
  }
  const shot = await session.page.screenshot({ type: "png" }).catch(() => null);
  return {
    statusCode: 200,
    body: {
      instanceName: safeName,
      status: session.status,
      screenshotBase64: shot ? `data:image/png;base64,${shot.toString("base64")}` : null,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function sendSessionInput(instanceName, input) {
  const safeName = sanitizeInstanceName(instanceName);
  const session = sessions.get(safeName);
  if (!session) {
    return { statusCode: 404, body: { error: "Sessão não está aberta" } };
  }

  if (input?.type === "click" && typeof input.x === "number" && typeof input.y === "number") {
    await session.page.mouse.click(input.x, input.y).catch(() => {});
  } else if (input?.type === "text" && typeof input.text === "string") {
    await session.page.keyboard.type(input.text, { delay: 25 }).catch(() => {});
  } else if (input?.type === "key" && typeof input.key === "string") {
    await session.page.keyboard.press(input.key).catch(() => {});
  } else if (input?.type === "goto" && typeof input.url === "string") {
    await session.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 350));
  return getSessionScreenshot(safeName);
}

export async function startShiftSession({ instanceName, clientId, proxy, shiftDurationMinutes }) {
  const safeName = sanitizeInstanceName(instanceName);
  const existing = sessions.get(safeName);
  if (existing && existing.status === "running") {
    return {
      statusCode: 200,
      body: {
        instanceName: safeName,
        status: "running",
        proxyIp: existing.proxyIp,
        updatedAt: existing.updatedAt,
      },
    };
  }
  if (existing) {
    await stopSession(safeName, "restart_shift");
  }

  if (sessions.size >= MAX_CONCURRENT) {
    return {
      statusCode: 429,
      body: {
        error: `Limite de ${MAX_CONCURRENT} browser(s) simultâneo(s) atingido`,
        maxConcurrent: MAX_CONCURRENT,
      },
    };
  }

  const launched = await launchBrowserSession({
    safeName,
    clientId,
    mode: "start",
    proxy,
    shiftDurationMinutes: Number(shiftDurationMinutes || 45),
  });

  if (!launched.ok) {
    return {
      statusCode: launched.needsExtensionSetup ? 409 : 400,
      body: launched,
    };
  }

  const session = launched.session;

  // Poll de hidratação (até 15s) para distinguir proxy lento de sessão realmente deslogada (QR visível)
  let loggedIn = false;
  let qrVisible = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    loggedIn = await detectWhatsAppLoggedIn(session.page);
    if (loggedIn) break;

    qrVisible = await session.page
      .locator('[data-ref] canvas, [data-testid="qrcode"] canvas')
      .first()
      .isVisible()
      .catch(() => false);
    if (qrVisible) break;
  }

  if (qrVisible && !loggedIn) {
    await stopSession(safeName, "whatsapp_web_logged_out");
    return {
      statusCode: 409,
      body: {
        instanceName: safeName,
        status: "qr_pending",
        error: "Sessão do WhatsApp Web desconectada; escaneie o QR Code novamente.",
      },
    };
  }

  if (loggedIn) {
    await ensureMmzapInjected(session);
  }

  return {
    statusCode: 200,
    body: {
      instanceName: safeName,
      status: "running",
      mmzapUiDetected: session.mmzapUiDetected,
      mmzapChipState: session.mmzapChipState,
      mmzapStatusLabel: session.mmzapStatusLabel,
      proxyIp: session.proxyIp,
      updatedAt: session.updatedAt,
    },
  };
}

export async function stopSession(instanceName, reason = "manual_stop") {
  const safeName = sanitizeInstanceName(instanceName);
  const session = sessions.get(safeName);
  if (!session) {
    return { statusCode: 200, body: { instanceName: safeName, status: "idle", reason } };
  }

  if (session.timer) clearTimeout(session.timer);
  sessions.delete(safeName);

  try {
    await session.context.close();
  } catch {}
  if (session.tunnel) {
    try {
      await session.tunnel.close();
    } catch {}
  }

  return {
    statusCode: 200,
    body: {
      instanceName: safeName,
      status: "idle",
      reason,
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function deleteSessionProfile(instanceName) {
  const safeName = sanitizeInstanceName(instanceName);
  await stopSession(safeName, "delete_profile");
  await fs.rm(path.join(PROFILES_DIR, safeName), { recursive: true, force: true }).catch(() => {});
  return { statusCode: 200, body: { ok: true, instanceName: safeName } };
}

export async function installExtensionZipBase64(zipBase64) {
  const clean = String(zipBase64 || "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!clean) {
    return { statusCode: 400, body: { error: "ZIP base64 vazio" } };
  }

  const tmpZip = path.join(DATA_DIR, `mmzap-ext-${Date.now()}.zip`);
  const tmpExtract = path.join(DATA_DIR, `mmzap-extract-${Date.now()}`);
  await fs.mkdir(tmpExtract, { recursive: true });
  await fs.writeFile(tmpZip, Buffer.from(clean, "base64"));

  try {
    await execFileAsync("unzip", ["-o", tmpZip, "-d", tmpExtract]);

    let sourceDir = tmpExtract;
    if (!(await fileExists(path.join(tmpExtract, "manifest.json")))) {
      const entries = await fs.readdir(tmpExtract, { withFileTypes: true });
      const firstDir = entries.find((e) => e.isDirectory());
      if (firstDir && (await fileExists(path.join(tmpExtract, firstDir.name, "manifest.json")))) {
        sourceDir = path.join(tmpExtract, firstDir.name);
      } else {
        return {
          statusCode: 400,
          body: { error: "manifest.json não encontrado no pacote ZIP da extensão." },
        };
      }
    }

    await fs.rm(EXTENSION_DIR, { recursive: true, force: true });
    await fs.mkdir(path.dirname(EXTENSION_DIR), { recursive: true });
    await fs.cp(sourceDir, EXTENSION_DIR, { recursive: true });

    const ext = await getExtensionStatus();
    return { statusCode: 200, body: { ok: true, extension: ext } };
  } finally {
    await fs.rm(tmpZip, { force: true }).catch(() => {});
    await fs.rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getHealthSnapshot() {
  const ext = await getExtensionStatus();
  const list = [];
  for (const sess of sessions.values()) {
    const pid = sess.context?.browser?.()?.process?.()?.pid;
    const rssMb = await readLinuxProcessTreeRssMb(pid);
    if (sess.status === "running") {
      const info = await inspectMmzapDom(sess.page);
      sess.mmzapUiDetected = info.mmzapUiDetected;
      sess.mmzapChipState = info.mmzapChipState;
      sess.mmzapStatusLabel = info.mmzapStatusLabel;
    }
    list.push({
      instanceName: sess.instanceName,
      status: sess.status,
      needsExtensionSetup: sess.needsExtensionSetup,
      mmzapUiDetected: sess.mmzapUiDetected,
      mmzapChipState: sess.mmzapChipState,
      mmzapStatusLabel: sess.mmzapStatusLabel,
      proxyIp: sess.proxyIp,
      rssMb,
      lastError: sess.lastError,
      uptimeSeconds: Math.round((Date.now() - sess.startedAtMs) / 1000),
      updatedAt: sess.updatedAt,
    });
  }

  return {
    ok: true,
    activeSessions: sessions.size,
    maxConcurrent: MAX_CONCURRENT,
    totalRssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    extension: ext,
    sessions: list,
  };
}

// Watchdog de RAM (30s): garante que nenhum Chromium passe de MAX_RSS_MB na VPS de 4 GB
setInterval(() => {
  void (async () => {
    for (const sess of Array.from(sessions.values())) {
      const pid = sess.context?.browser?.()?.process?.()?.pid;
      const rssMb = await readLinuxProcessTreeRssMb(pid);
      if (rssMb && rssMb > MAX_RSS_MB) {
        console.warn(`[mmzap-worker] Reciclando ${sess.instanceName}: RSS ${rssMb}MB > ${MAX_RSS_MB}MB`);
        await stopSession(sess.instanceName, "ram_watchdog_recycle");
      }
    }
  })();
}, 30_000).unref();
