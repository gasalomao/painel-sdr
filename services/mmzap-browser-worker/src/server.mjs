import http from "node:http";
import {
  deleteSessionProfile,
  getExtensionStatus,
  getHealthSnapshot,
  getPairingQr,
  getSessionScreenshot,
  getSessionStatus,
  installExtensionZipBase64,
  logoutSession,
  markSetupDone,
  openSetupSession,
  sendSessionInput,
  startPairingSession,
  startShiftSession,
  stopAllSessions,
  stopSession,
} from "./session-manager.mjs";

const PORT = Number(process.env.PORT || 3099);
const SECRET = String(
  process.env.MMZAP_WORKER_SECRET ||
    process.env.MMZAP_BROWSER_WORKER_SECRET ||
    process.env.INTERNAL_SECRET ||
    ""
).trim();

const IGNORABLE_PROCESS_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNABORTED",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.warn(`[mmzap-browser-worker] unhandledRejection ignorada para manter serviço ativo: ${msg}`);
});

process.on("uncaughtException", (err) => {
  const code = err && typeof err === "object" ? String(err.code || "") : "";
  if (IGNORABLE_PROCESS_ERROR_CODES.has(code)) {
    console.warn(`[mmzap-browser-worker] Erro de stream transitório interceptado (${code}): ${err.message}`);
    return;
  }
  console.error("[mmzap-browser-worker] uncaughtException:", err);
});

function sendJson(res, statusCode, payload) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    /* cliente desconectou antes da resposta */
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 25 * 1024 * 1024) {
      throw new Error("Payload excedeu 25MB");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function isAuthorized(req) {
  if (!SECRET) return true;
  const header = String(req.headers["x-internal-secret"] || "").trim();
  return header === SECRET;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const method = (req.method || "GET").toUpperCase();

  if (method === "GET" && url.pathname === "/health") {
    try {
      const snap = await getHealthSnapshot();
      return sendJson(res, 200, snap);
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : "Erro ao coletar health snapshot",
      });
    }
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  try {
    if (method === "GET" && url.pathname === "/extensions/status") {
      const ext = await getExtensionStatus();
      return sendJson(res, 200, { ok: true, extension: ext });
    }

    if (method === "POST" && url.pathname === "/extensions/upload") {
      const body = await readJsonBody(req);
      const out = await installExtensionZipBase64(body.zipBase64);
      return sendJson(res, out.statusCode, out.body);
    }

    const statusMatch = url.pathname.match(/^\/sessions\/([^/]+)\/status$/);
    if (method === "GET" && statusMatch) {
      const out = await getSessionStatus(decodeURIComponent(statusMatch[1]));
      return sendJson(res, out.statusCode, out.body);
    }

    const pairMatch = url.pathname.match(/^\/sessions\/([^/]+)\/pair$/);
    if (method === "POST" && pairMatch) {
      const body = await readJsonBody(req);
      const out = await startPairingSession({
        instanceName: decodeURIComponent(pairMatch[1]),
        clientId: body.clientId,
        proxy: body.proxy || null,
        shiftDurationMinutes: body.shiftDurationMinutes,
        resetProfile: Boolean(body.resetProfile),
      });
      return sendJson(res, out.statusCode, out.body);
    }

    const qrMatch = url.pathname.match(/^\/sessions\/([^/]+)\/qr$/);
    if (method === "GET" && qrMatch) {
      const out = await getPairingQr(decodeURIComponent(qrMatch[1]));
      return sendJson(res, out.statusCode, out.body);
    }

    const setupMatch = url.pathname.match(/^\/sessions\/([^/]+)\/setup$/);
    if (method === "POST" && setupMatch) {
      const body = await readJsonBody(req);
      const out = await openSetupSession({
        instanceName: decodeURIComponent(setupMatch[1]),
        clientId: body.clientId,
        proxy: body.proxy || null,
        setupUrl: body.setupUrl || undefined,
      });
      return sendJson(res, out.statusCode, out.body);
    }

    const setupDoneMatch = url.pathname.match(/^\/sessions\/([^/]+)\/setup-complete$/);
    if (method === "POST" && setupDoneMatch) {
      const out = await markSetupDone(decodeURIComponent(setupDoneMatch[1]));
      return sendJson(res, 200, out);
    }

    const shotMatch = url.pathname.match(/^\/sessions\/([^/]+)\/screenshot$/);
    if (method === "GET" && shotMatch) {
      const out = await getSessionScreenshot(decodeURIComponent(shotMatch[1]));
      return sendJson(res, out.statusCode, out.body);
    }

    const inputMatch = url.pathname.match(/^\/sessions\/([^/]+)\/input$/);
    if (method === "POST" && inputMatch) {
      const body = await readJsonBody(req);
      const out = await sendSessionInput(decodeURIComponent(inputMatch[1]), body);
      return sendJson(res, out.statusCode, out.body);
    }

    const startMatch = url.pathname.match(/^\/sessions\/([^/]+)\/start$/);
    if (method === "POST" && startMatch) {
      const body = await readJsonBody(req);
      const out = await startShiftSession({
        instanceName: decodeURIComponent(startMatch[1]),
        clientId: body.clientId,
        proxy: body.proxy || null,
        shiftDurationMinutes: body.shiftDurationMinutes,
      });
      return sendJson(res, out.statusCode, out.body);
    }

    const stopMatch = url.pathname.match(/^\/sessions\/([^/]+)\/stop$/);
    if (method === "POST" && stopMatch) {
      const body = await readJsonBody(req).catch(() => ({}));
      const out = await stopSession(decodeURIComponent(stopMatch[1]), body.reason || "manual_stop");
      return sendJson(res, out.statusCode, out.body);
    }

    const logoutMatch = url.pathname.match(/^\/sessions\/([^/]+)\/logout$/);
    if (method === "POST" && logoutMatch) {
      const out = await logoutSession(decodeURIComponent(logoutMatch[1]));
      return sendJson(res, out.statusCode, out.body);
    }

    const delMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (method === "DELETE" && delMatch) {
      const out = await deleteSessionProfile(decodeURIComponent(delMatch[1]));
      return sendJson(res, out.statusCode, out.body);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, {
      error: err instanceof Error ? err.message : "Erro interno no mmzap-browser-worker",
    });
  }
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mmzap-browser-worker] Recebido ${signal}; encerrando sessões Chromium e túneis proxy...`);
  try {
    await stopAllSessions(`signal_${signal}`);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mmzap-browser-worker] Ouvindo na porta ${PORT}`);
});
