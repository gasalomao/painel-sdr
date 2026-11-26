import http from "node:http";
import {
  deleteSessionProfile,
  getExtensionStatus,
  getHealthSnapshot,
  getPairingQr,
  getSessionScreenshot,
  installExtensionZipBase64,
  markSetupDone,
  openSetupSession,
  sendSessionInput,
  startPairingSession,
  startShiftSession,
  stopSession,
} from "./session-manager.mjs";

const PORT = Number(process.env.PORT || 3099);
const SECRET = String(process.env.MMZAP_WORKER_SECRET || process.env.INTERNAL_SECRET || "").trim();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
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
    const snap = await getHealthSnapshot();
    return sendJson(res, 200, snap);
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

    const pairMatch = url.pathname.match(/^\/sessions\/([^/]+)\/pair$/);
    if (method === "POST" && pairMatch) {
      const body = await readJsonBody(req);
      const out = await startPairingSession({
        instanceName: decodeURIComponent(pairMatch[1]),
        clientId: body.clientId,
        proxy: body.proxy || null,
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mmzap-browser-worker] Ouvindo na porta ${PORT}`);
});
