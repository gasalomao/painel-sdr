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
const LOGOUT_GRACE_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.MMZAP_WATCHDOG_INTERVAL_MS || 50_000) || 50_000
);
const WATCHDOG_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;

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

async function clearSavedLogoutMarker(profileDir) {
  try {
    await fs.rm(path.join(profileDir, ".mmzap-logged-out"), { force: true });
  } catch {}
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

async function withTimeout(promise, timeoutMs, fallbackValue) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } catch {
    return fallbackValue;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readSinglePidRssKb(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const match = raw.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function collectDescendantPids(rootPid, visited = new Set(), depth = 0) {
  if (!rootPid || visited.has(rootPid) || depth > 4) return visited;
  visited.add(rootPid);
  try {
    const tasksDir = `/proc/${rootPid}/task`;
    const tids = await fs.readdir(tasksDir);
    for (const tid of tids) {
      try {
        const raw = await fs.readFile(`${tasksDir}/${tid}/children`, "utf8");
        const childPids = raw
          .trim()
          .split(/\s+/)
          .map((s) => Number(s))
          .filter((n) => Number.isFinite(n) && n > 0 && !visited.has(n));
        for (const childPid of childPids) {
          await collectDescendantPids(childPid, visited, depth + 1);
        }
      } catch {
        /* thread encerrada */
      }
    }
  } catch {
    /* processo encerrado ou sem acesso */
  }
  return visited;
}

async function readLinuxProcessTreeRssMb(pid) {
  if (!pid || process.platform !== "linux") return null;
  try {
    const pids = await collectDescendantPids(Number(pid));
    if (pids.size === 0) return null;
    let totalKb = 0;
    for (const p of pids) {
      totalKb += await readSinglePidRssKb(p);
    }
    if (totalKb <= 0) return null;
    return Math.round((totalKb / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

async function detectWhatsAppLoggedIn(page, timeoutMs = 4_000) {
  if (!page || page.isClosed()) return false;
  return withTimeout(
    page
      .evaluate(() => {
        return Boolean(
          document.querySelector('[data-testid="chat-list"]') ||
            document.querySelector("#pane-side") ||
            document.querySelector('[aria-label="Lista de conversas"]') ||
            document.querySelector('[aria-label="Chat list"]')
        );
      })
      .then((res) => Boolean(res))
      .catch(() => false),
    timeoutMs,
    false
  );
}

async function detectWhatsAppLoggedOut(page, timeoutMs = 4_000) {
  if (!page || page.isClosed()) return false;
  return withTimeout(
    page
      .evaluate(() => {
        const hasAuthenticatedUi = Boolean(
          document.querySelector('[data-testid="chat-list"]') ||
            document.querySelector("#pane-side") ||
            document.querySelector('[aria-label="Lista de conversas"]') ||
            document.querySelector('[aria-label="Chat list"]')
        );
        if (hasAuthenticatedUi) return false;

        const hasQrCanvas = Boolean(
          document.querySelector('[data-ref] canvas') ||
            document.querySelector('[data-testid="qrcode"] canvas') ||
            document.querySelector('canvas[aria-label*="Scan"]') ||
            document.querySelector('canvas[aria-label*="QR"]') ||
            document.querySelector('canvas[aria-label*="código"]')
        );
        if (hasQrCanvas) return true;

        const hasLandingDom = Boolean(
          document.querySelector(".landing-wrapper") ||
            document.querySelector('[data-testid="intro-md-beta-logo-dark"]') ||
            document.querySelector('[data-testid="intro-md-beta-logo-light"]') ||
            document.querySelector('[data-testid="link-device-qrcode-alt-linking-hint"]')
        );
        if (hasLandingDom) return true;

        const bodyText = String(document.body?.innerText || "").toLowerCase();
        return (
          bodyText.includes("vincule com número de telefone") ||
          bodyText.includes("link with phone number") ||
          bodyText.includes("use o whatsapp no seu computador") ||
          bodyText.includes("use whatsapp on your computer") ||
          bodyText.includes("etapas para conectar") ||
          bodyText.includes("steps to log in")
        );
      })
      .then((res) => Boolean(res))
      .catch(() => false),
    timeoutMs,
    false
  );
}

async function inspectMmzapDom(page, timeoutMs = 3_000) {
  const empty = { mmzapUiDetected: false, mmzapChipState: null, mmzapStatusLabel: null };
  if (!page || page.isClosed()) {
    return empty;
  }
  return withTimeout(
    page
      .evaluate(() => {
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
      })
      .catch(() => empty),
    timeoutMs,
    empty
  );
}

function isChipStateOff(state) {
  return state === "is-off" || state === "off";
}

function isChipStateError(state) {
  return state === "is-error" || state === "error";
}

function readTunnelTelemetry(session) {
  const health = session?.tunnel?.getHealth?.() || null;
  if (!health) {
    return {
      proxyLatencyMs: session?.proxyLatencyMs ?? null,
      proxyErrorCount: 0,
      proxyHealthy: true,
      consecutiveErrors: 0,
      lastError: null,
    };
  }
  if (typeof health.lastLatencyMs === "number") {
    session.proxyLatencyMs = health.lastLatencyMs;
  }
  return {
    proxyLatencyMs: health.lastLatencyMs ?? session?.proxyLatencyMs ?? null,
    proxyErrorCount: Number(health.errorCount || 0),
    proxyHealthy: Boolean(health.healthy),
    consecutiveErrors: Number(health.consecutiveErrors || 0),
    lastError: health.lastError || null,
  };
}

function serializeSessionStatus(sess, rssMb = null) {
  const tunnel = readTunnelTelemetry(sess);
  return {
    instanceName: sess.instanceName,
    status: sess.status,
    needsExtensionSetup: Boolean(sess.needsExtensionSetup),
    mmzapUiDetected: Boolean(sess.mmzapUiDetected),
    mmzapChipState: sess.mmzapChipState ?? null,
    mmzapStatusLabel: sess.mmzapStatusLabel ?? null,
    sessionLoggedOut: Boolean(sess.sessionLoggedOut),
    mmzapWatchdogRecoveries: Number(sess.mmzapWatchdogRecoveries || 0),
    lastWatchdogCheckAt: sess.lastWatchdogCheckAt ?? null,
    proxyIp: sess.proxyIp ?? null,
    proxyLatencyMs: tunnel.proxyLatencyMs,
    proxyErrorCount: tunnel.proxyErrorCount,
    proxyHealthy: tunnel.proxyHealthy,
    rssMb,
    lastError: sess.lastError ?? null,
    uptimeSeconds: Math.round((Date.now() - sess.startedAtMs) / 1000),
    updatedAt: sess.updatedAt,
  };
}

function closeExtraPages(session) {
  if (!session?.context) return;
  try {
    for (const extraPage of session.context.pages()) {
      if (extraPage !== session.page) {
        void extraPage.close().catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}

function clearSessionWatchdog(session) {
  if (!session) return;
  if (session.watchdogTimer) {
    clearInterval(session.watchdogTimer);
    session.watchdogTimer = null;
  }
}

function clearSessionTimers(session) {
  if (!session) return;
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  clearSessionWatchdog(session);
}

async function runSessionWatchdogTick(session) {
  if (
    !session ||
    session.closing ||
    session.watchdogRunning ||
    session.ensuringMmzap ||
    session.status !== "running" ||
    sessions.get(session.instanceName) !== session
  ) {
    return;
  }

  session.watchdogRunning = true;
  try {
    closeExtraPages(session);

    if (!session.page || session.page.isClosed()) {
      session.lastError = "page_closed";
      await stopSession(session.instanceName, "page_closed");
      return;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    session.lastWatchdogCheckAt = nowIso;

    // Atualiza saúde do túnel proxy e sinaliza falhas persistentes sem derrubar o worker
    const tunnel = readTunnelTelemetry(session);
    if (!tunnel.proxyHealthy && tunnel.consecutiveErrors >= 5) {
      if (!session.lastError || String(session.lastError).startsWith("proxy_")) {
        session.lastError = tunnel.lastError ? `proxy_error: ${tunnel.lastError}` : "proxy_unreachable";
      }
    } else if (tunnel.proxyHealthy && session.lastError && String(session.lastError).startsWith("proxy_")) {
      session.lastError = null;
    }

    const isAuthenticated = await detectWhatsAppLoggedIn(session.page);
    if (!isAuthenticated) {
      const isLoggedOutScreen = await detectWhatsAppLoggedOut(session.page);
      if (isLoggedOutScreen) {
        session.loggedOutStreak = (session.loggedOutStreak || 0) + 1;
        session.unhealthyDomStreak = 0;

        if (session.loggedOutStreak >= 2) {
          session.sessionLoggedOut = true;
          session.status = "qr_pending";
          session.lastError = "qr_required";
          session.qrCodeBase64 = null;
          session.mmzapUiDetected = false;
          session.mmzapChipState = null;
          session.mmzapStatusLabel = null;
          session.loggedOutStreak = 0;
          session.unhealthyDomStreak = 0;
          session.updatedAt = nowIso;

          await clearSavedLogoutMarker(path.join(PROFILES_DIR, session.instanceName));
          clearSessionWatchdog(session);
          if (session.timer) clearTimeout(session.timer);
          session.timer = setTimeout(() => {
            void stopSession(session.instanceName, "whatsapp_web_logged_out");
          }, LOGOUT_GRACE_MS);
          if (typeof session.timer.unref === "function") session.timer.unref();

          console.warn(
            `[mmzap-worker] Watchdog detectou logout do WhatsApp Web em ${session.instanceName} (2 checks consecutivos) -> qr_pending / qr_required`
          );
        }
      }
      return;
    }

    // Sessão autenticada no WhatsApp Web
    session.loggedOutStreak = 0;
    session.sessionLoggedOut = false;
    if (session.lastError === "qr_required") {
      session.lastError = null;
    }

    const info = await inspectMmzapDom(session.page);
    session.mmzapUiDetected = info.mmzapUiDetected;
    session.mmzapChipState = info.mmzapChipState;
    session.mmzapStatusLabel = info.mmzapStatusLabel;
    session.updatedAt = nowIso;

    const chipOff = isChipStateOff(info.mmzapChipState);
    const chipError = isChipStateError(info.mmzapChipState);
    const isUnhealthy = !info.mmzapUiDetected || chipOff || chipError;

    if (!isUnhealthy) {
      session.unhealthyDomStreak = 0;
      return;
    }

    session.unhealthyDomStreak = (session.unhealthyDomStreak || 0) + 1;
    if (session.unhealthyDomStreak < 2) {
      return;
    }

    const canRecover =
      !session.lastWatchdogRecoveryAtMs ||
      nowMs - session.lastWatchdogRecoveryAtMs >= WATCHDOG_RECOVERY_COOLDOWN_MS;
    if (!canRecover) {
      return;
    }

    session.lastWatchdogRecoveryAtMs = nowMs;
    session.unhealthyDomStreak = 0;

    if (chipOff && info.mmzapUiDetected) {
      const chipLoc = session.page.locator("#mmzap-chip").first();
      const visible = await chipLoc.isVisible().catch(() => false);
      if (visible) {
        await chipLoc.click({ timeout: 5_000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3_000));
      }

      const afterClick = await inspectMmzapDom(session.page);
      session.mmzapUiDetected = afterClick.mmzapUiDetected;
      session.mmzapChipState = afterClick.mmzapChipState;
      session.mmzapStatusLabel = afterClick.mmzapStatusLabel;
      session.mmzapWatchdogRecoveries = (session.mmzapWatchdogRecoveries || 0) + 1;
      session.lastWatchdogCheckAt = new Date().toISOString();
      session.updatedAt = session.lastWatchdogCheckAt;

      console.log(
        `[mmzap-worker] Watchdog reativou #mmzap-chip em ${session.instanceName} via clique (estado=${afterClick.mmzapChipState}, recuperações=${session.mmzapWatchdogRecoveries})`
      );
      return;
    }

    // !mmzapUiDetected ou is-error: recarrega WhatsApp Web uma vez e aguarda até 15s por #mmzap-chip
    await session.page
      .reload({ waitUntil: "domcontentloaded", timeout: 35_000 })
      .catch(() => {});

    let recovered = await inspectMmzapDom(session.page);
    for (let i = 0; i < 15; i++) {
      if (
        session.closing ||
        sessions.get(session.instanceName) !== session ||
        session.status !== "running"
      ) {
        break;
      }
      if (recovered.mmzapUiDetected && !isChipStateError(recovered.mmzapChipState)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
      recovered = await inspectMmzapDom(session.page);
    }

    session.mmzapUiDetected = recovered.mmzapUiDetected;
    session.mmzapChipState = recovered.mmzapChipState;
    session.mmzapStatusLabel = recovered.mmzapStatusLabel;
    session.mmzapWatchdogRecoveries = (session.mmzapWatchdogRecoveries || 0) + 1;
    session.lastWatchdogCheckAt = new Date().toISOString();
    session.updatedAt = session.lastWatchdogCheckAt;

    console.log(
      `[mmzap-worker] Watchdog recarregou WhatsApp Web em ${session.instanceName} (mmzapUiDetected=${recovered.mmzapUiDetected}, estado=${recovered.mmzapChipState}, recuperações=${session.mmzapWatchdogRecoveries})`
    );
  } catch (err) {
    console.warn(
      `[mmzap-worker] Erro transitório no watchdog de ${session.instanceName}:`,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    session.watchdogRunning = false;
  }
}

function startSessionWatchdog(session) {
  if (!session || session.closing) return;
  clearSessionWatchdog(session);
  session.watchdogTimer = setInterval(() => {
    void runSessionWatchdogTick(session);
  }, WATCHDOG_INTERVAL_MS);
  if (typeof session.watchdogTimer.unref === "function") {
    session.watchdogTimer.unref();
  }
}

async function ensureMmzapInjected(session) {
  if (!session || session.ensuringMmzap || session.closing) return;
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

    // Contorna o limite de 10x2s (20s) do content.js da MMZap quando veio da tela de QR ou proxy lenta
    await session.page
      .reload({ waitUntil: "domcontentloaded", timeout: 35_000 })
      .catch(() => {});

    for (let i = 0; i < 15; i++) {
      if (session.closing || sessions.get(session.instanceName) !== session) break;
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
    if (!page || page.isClosed()) return null;
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
  await clearSavedLogoutMarker(profileDir);

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
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
    "--disk-cache-size=33554432",
    "--media-cache-size=16777216",
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

  // Evita aba duplicada ou popups abertos pelo chrome.runtime.onInstalled/window.open (poupa RAM)
  context.on("page", (extraPage) => {
    if (extraPage !== page) {
      void extraPage.close().catch(() => {});
    }
  });
  page.on("popup", (popupPage) => {
    if (popupPage !== page) {
      void popupPage.close().catch(() => {});
    }
  });
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => {});
  });

  const session = {
    instanceName: safeName,
    clientId: String(clientId || ""),
    status: mode === "pair" ? "qr_pending" : mode === "setup" ? "setup" : "running",
    context,
    page,
    tunnel,
    proxyIp: proxy?.sourceHost || tunnel?.upstreamHost || null,
    proxyLatencyMs: null,
    qrCodeBase64: null,
    needsExtensionSetup: requiresManualSetup,
    shiftDurationMinutes: Math.max(5, Number(shiftDurationMinutes || 40)),
    mmzapUiDetected: false,
    mmzapChipState: null,
    mmzapStatusLabel: null,
    sessionLoggedOut: false,
    mmzapWatchdogRecoveries: 0,
    lastWatchdogCheckAt: null,
    lastWatchdogRecoveryAtMs: null,
    loggedOutStreak: 0,
    unhealthyDomStreak: 0,
    ensuringMmzap: false,
    watchdogTimer: null,
    watchdogRunning: false,
    closing: false,
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
  if (typeof session.timer.unref === "function") session.timer.unref();

  const cleanupOnUnexpectedExit = (reason) => {
    if (sessions.get(safeName) !== session) return;
    session.lastError = session.lastError || reason;
    clearSessionTimers(session);
    sessions.delete(safeName);
    if (session.tunnel) {
      void session.tunnel.close().catch(() => {});
    }
  };

  context.on("close", () => cleanupOnUnexpectedExit("context_closed"));
  const browser = context.browser?.();
  if (browser && typeof browser.on === "function") {
    browser.on("disconnected", () => cleanupOnUnexpectedExit("browser_disconnected"));
  }

  page.on("crash", () => {
    if (sessions.get(safeName) !== session || session.closing) return;
    console.warn(`[mmzap-worker] Aba do Chromium travou (crash) em ${safeName}; encerrando para liberar RAM.`);
    session.lastError = "page_crashed";
    void stopSession(safeName, "page_crashed");
  });

  page.on("close", () => {
    if (sessions.get(safeName) !== session || session.closing) return;
    session.lastError = session.lastError || "page_closed";
    void stopSession(safeName, "page_closed");
  });

  try {
    await page.goto("https://web.whatsapp.com", {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    session.lastError = msg;
    session.gotoError = msg;
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
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void stopSession(safeName, "qr_timeout");
    }, QR_TIMEOUT_MS);
    if (typeof existing.timer.unref === "function") existing.timer.unref();
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
        sessionLoggedOut: false,
        mmzapWatchdogRecoveries: 0,
        lastWatchdogCheckAt: null,
        proxyLatencyMs: null,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (session.status === "running") {
    if (!session.ensuringMmzap && !session.watchdogRunning) {
      const info = await inspectMmzapDom(session.page);
      session.mmzapUiDetected = info.mmzapUiDetected;
      session.mmzapChipState = info.mmzapChipState;
      session.mmzapStatusLabel = info.mmzapStatusLabel;
    }
    return {
      statusCode: 200,
      body: {
        ...serializeSessionStatus(session),
        needsExtensionSetup: false,
        qrCodeBase64: null,
      },
    };
  }

  const loggedIn = await detectWhatsAppLoggedIn(session.page);
  if (loggedIn) {
    session.qrCodeBase64 = null;
    session.sessionLoggedOut = false;
    session.loggedOutStreak = 0;
    session.unhealthyDomStreak = 0;
    if (session.lastError === "qr_required") {
      session.lastError = null;
    }
    session.updatedAt = new Date().toISOString();

    if (session.needsExtensionSetup) {
      session.status = "needs_extension_setup";
      session.mode = "setup";
      clearSessionWatchdog(session);
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        void stopSession(safeName, "setup_timeout");
      }, 10 * 60 * 1000);
      if (typeof session.timer.unref === "function") session.timer.unref();
    } else {
      // Mantém o Chromium logado aberto e inicia o 1º turno MMZap automaticamente,
      // recarregando a aba para garantir que o content.js da extensão injete (janela de 20s).
      session.mode = "start";
      session.status = "running";
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        void stopSession(safeName, "shift_timeout");
      }, Math.max(5, session.shiftDurationMinutes || 40) * 60 * 1000);
      if (typeof session.timer.unref === "function") session.timer.unref();
      await ensureMmzapInjected(session);
      startSessionWatchdog(session);
    }

    return {
      statusCode: 200,
      body: {
        ...serializeSessionStatus(session),
        qrCodeBase64: null,
      },
    };
  }

  const qr = await captureQrDataUrl(session.page);
  session.qrCodeBase64 = qr;
  session.updatedAt = new Date().toISOString();

  return {
    statusCode: 200,
    body: {
      ...serializeSessionStatus(session),
      status: "qr_pending",
      qrCodeBase64: qr,
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
    clearSessionWatchdog(session);
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

  if (!session.ensuringMmzap && !session.watchdogRunning) {
    const info = await inspectMmzapDom(session.page);
    session.mmzapUiDetected = info.mmzapUiDetected;
    session.mmzapChipState = info.mmzapChipState;
    session.mmzapStatusLabel = info.mmzapStatusLabel;
    const isLoggedOut = await detectWhatsAppLoggedOut(session.page);
    if (isLoggedOut) {
      session.sessionLoggedOut = true;
    } else if (await detectWhatsAppLoggedIn(session.page)) {
      session.sessionLoggedOut = false;
    }
  }

  const shot = await session.page.screenshot({ type: "png" }).catch(() => null);
  return {
    statusCode: 200,
    body: {
      ...serializeSessionStatus(session),
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

  if (!session.ensuringMmzap && !session.watchdogRunning) {
    const info = await inspectMmzapDom(session.page);
    session.mmzapUiDetected = info.mmzapUiDetected;
    session.mmzapChipState = info.mmzapChipState;
    session.mmzapStatusLabel = info.mmzapStatusLabel;
    const isLoggedOut = await detectWhatsAppLoggedOut(session.page);
    if (isLoggedOut) {
      session.sessionLoggedOut = true;
    } else if (await detectWhatsAppLoggedIn(session.page)) {
      session.sessionLoggedOut = false;
    }
  }

  const shot = await session.page.screenshot({ type: "png" }).catch(() => null);
  return {
    statusCode: 200,
    body: {
      ...serializeSessionStatus(session),
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
  if (existing && existing.status === "running" && !existing.sessionLoggedOut) {
    startSessionWatchdog(existing);
    return {
      statusCode: 200,
      body: serializeSessionStatus(existing),
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

  // Poll de hidratação (até 20s) para distinguir proxy lento de sessão deslogada ou aba morta (chrome-error://)
  let loggedIn = false;
  let qrVisible = false;
  let navigationFailed = Boolean(session.gotoError);

  if (!navigationFailed) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (session.closing || sessions.get(safeName) !== session) {
        return {
          statusCode: 500,
          body: {
            instanceName: safeName,
            status: "error",
            error: "Sessão do Chromium encerrou durante a inicialização do turno.",
          },
        };
      }

      const currentUrl = session.page.url() || "";
      if (currentUrl.startsWith("chrome-error://")) {
        navigationFailed = true;
        break;
      }

      loggedIn = await detectWhatsAppLoggedIn(session.page);
      if (loggedIn) break;

      qrVisible = await detectWhatsAppLoggedOut(session.page);
      if (qrVisible) break;

      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (qrVisible && !loggedIn) {
    const tunnel = readTunnelTelemetry(session);
    await stopSession(safeName, "whatsapp_web_logged_out");
    return {
      statusCode: 409,
      body: {
        instanceName: safeName,
        status: "qr_pending",
        sessionLoggedOut: true,
        mmzapWatchdogRecoveries: 0,
        lastWatchdogCheckAt: new Date().toISOString(),
        proxyIp: session.proxyIp,
        proxyLatencyMs: tunnel.proxyLatencyMs,
        lastError: "qr_required",
        error: "Sessão do WhatsApp Web desconectada; escaneie o QR Code novamente.",
      },
    };
  }

  if (!loggedIn) {
    const tunnel = readTunnelTelemetry(session);
    const currentUrl = session.page && !session.page.isClosed() ? session.page.url() || "" : "";
    const isProxyOrNavErr =
      navigationFailed ||
      currentUrl.startsWith("chrome-error://") ||
      currentUrl === "about:blank" ||
      tunnel.consecutiveErrors > 0;
    const reason = isProxyOrNavErr ? "whatsapp_web_proxy_error" : "whatsapp_web_hydration_timeout";
    const errDetail = session.gotoError || tunnel.lastError || null;
    await stopSession(safeName, reason);
    return {
      statusCode: isProxyOrNavErr ? 502 : 503,
      body: {
        instanceName: safeName,
        status: "error",
        sessionLoggedOut: false,
        mmzapWatchdogRecoveries: 0,
        lastWatchdogCheckAt: new Date().toISOString(),
        proxyIp: session.proxyIp,
        proxyLatencyMs: tunnel.proxyLatencyMs,
        lastError: reason,
        error: isProxyOrNavErr
          ? `Falha ao abrir WhatsApp Web pelo proxy${errDetail ? ` (${errDetail})` : ""}.`
          : "WhatsApp Web não concluiu o carregamento em 20s (proxy lento ou página travada).",
      },
    };
  }

  session.sessionLoggedOut = false;
  session.loggedOutStreak = 0;
  session.lastError = null;
  await ensureMmzapInjected(session);

  startSessionWatchdog(session);

  return {
    statusCode: 200,
    body: serializeSessionStatus(session),
  };
}

export async function getSessionStatus(instanceName) {
  const safeName = sanitizeInstanceName(instanceName);
  const sess = sessions.get(safeName);
  if (!sess) {
    return {
      statusCode: 200,
      body: {
        instanceName: safeName,
        status: "idle",
        needsExtensionSetup: false,
        mmzapUiDetected: false,
        mmzapChipState: null,
        mmzapStatusLabel: null,
        sessionLoggedOut: false,
        mmzapWatchdogRecoveries: 0,
        lastWatchdogCheckAt: null,
        proxyIp: null,
        proxyLatencyMs: null,
        rssMb: null,
        lastError: null,
        uptimeSeconds: 0,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const pid = sess.context?.browser?.()?.process?.()?.pid;
  const rssMb = await readLinuxProcessTreeRssMb(pid);
  if (sess.status === "running" && !sess.ensuringMmzap && !sess.watchdogRunning) {
    const info = await inspectMmzapDom(sess.page);
    sess.mmzapUiDetected = info.mmzapUiDetected;
    sess.mmzapChipState = info.mmzapChipState;
    sess.mmzapStatusLabel = info.mmzapStatusLabel;
  }

  return {
    statusCode: 200,
    body: serializeSessionStatus(sess, rssMb),
  };
}

export async function stopSession(instanceName, reason = "manual_stop") {
  const safeName = sanitizeInstanceName(instanceName);
  const session = sessions.get(safeName);
  if (!session) {
    return { statusCode: 200, body: { instanceName: safeName, status: "idle", reason } };
  }

  session.closing = true;
  clearSessionTimers(session);
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

export async function stopAllSessions(reason = "worker_shutdown") {
  const names = Array.from(sessions.keys());
  await Promise.allSettled(names.map((name) => stopSession(name, reason)));
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
    if (sess.status === "running" && !sess.ensuringMmzap && !sess.watchdogRunning) {
      const info = await inspectMmzapDom(sess.page);
      sess.mmzapUiDetected = info.mmzapUiDetected;
      sess.mmzapChipState = info.mmzapChipState;
      sess.mmzapStatusLabel = info.mmzapStatusLabel;
    }
    list.push(serializeSessionStatus(sess, rssMb));
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
