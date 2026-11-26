import http from "node:http";
import net from "node:net";

const HANDSHAKE_TIMEOUT_MS = 20_000;
const IDLE_TUNNEL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CONNECT_HEADER_BYTES = 64 * 1024;
const UNHEALTHY_CONSECUTIVE_ERRORS = 5;

const IGNORABLE_STREAM_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNABORTED",
  "ECANCELED",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function safeDecodeURIComponent(value) {
  const str = String(value || "");
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function isIgnorableStreamError(err) {
  if (!err || typeof err !== "object") return false;
  return IGNORABLE_STREAM_ERROR_CODES.has(String(err.code || ""));
}

function safeWrite(socket, data) {
  if (!socket || socket.destroyed || !socket.writable || socket.writableEnded) {
    return false;
  }
  try {
    socket.write(data);
    return true;
  } catch {
    return false;
  }
}

function safeEnd(socket, data) {
  if (!socket || socket.destroyed || socket.writableEnded) {
    return;
  }
  try {
    if (data !== undefined) {
      socket.end(data);
    } else {
      socket.end();
    }
  } catch {
    /* ignore double-end or destroyed stream */
  }
}

function safeDestroy(socket) {
  if (!socket || socket.destroyed) return;
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * Cria um túnel proxy HTTP/HTTPS local em 127.0.0.1 que injeta
 * `Proxy-Authorization: Basic ...` antes de repassar para o proxy upstream
 * autenticado da Webshare/pool. Necessário porque o `--proxy-server` do Chromium
 * não aceita usuário e senha inline na URL.
 */
export async function createAuthenticatedProxyTunnel(proxyConfig) {
  if (!proxyConfig || !proxyConfig.server) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(proxyConfig.server);
  } catch {
    throw new Error(`URL de proxy inválida: ${proxyConfig.server}`);
  }

  const upstreamHost = parsed.hostname;
  const upstreamPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const username = proxyConfig.username || parsed.username || "";
  const password = proxyConfig.password || parsed.password || "";
  const authHeader =
    username || password
      ? `Basic ${Buffer.from(
          `${safeDecodeURIComponent(username)}:${safeDecodeURIComponent(password)}`
        ).toString("base64")}`
      : null;

  const activeSockets = new Set();

  let errorCount = 0;
  let consecutiveErrors = 0;
  let totalConnections = 0;
  let lastLatencyMs = null;
  let lastError = null;
  let lastErrorAt = null;
  let lastSuccessAt = null;
  let isClosed = false;

  const recordSuccess = (elapsedMs) => {
    const clamped = Math.max(0, Math.round(Number(elapsedMs) || 0));
    lastLatencyMs =
      lastLatencyMs === null
        ? clamped
        : Math.round(lastLatencyMs * 0.6 + clamped * 0.4);
    consecutiveErrors = 0;
    lastSuccessAt = new Date().toISOString();
  };

  const recordError = (err, source) => {
    errorCount += 1;
    consecutiveErrors += 1;
    const detail =
      err && typeof err === "object"
        ? err.code || err.message || String(err)
        : String(err || "unknown");
    lastError = `${source}: ${detail}`.slice(0, 180);
    lastErrorAt = new Date().toISOString();
  };

  const server = http.createServer((clientReq, clientRes) => {
    totalConnections += 1;
    const startedAt = Date.now();
    let settled = false;

    const headers = { ...clientReq.headers };
    if (authHeader) {
      headers["proxy-authorization"] = authHeader;
    }

    const upstreamReq = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: clientReq.method,
        path: clientReq.url,
        headers,
        timeout: HANDSHAKE_TIMEOUT_MS,
      },
      (upstreamRes) => {
        if (!settled) {
          settled = true;
          recordSuccess(Date.now() - startedAt);
        }

        if (clientRes.destroyed || clientRes.writableEnded) {
          upstreamRes.resume();
          safeDestroy(upstreamRes);
          return;
        }

        try {
          clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        } catch {
          safeDestroy(upstreamRes);
          safeDestroy(clientRes);
          return;
        }

        upstreamRes.on("error", (err) => {
          if (!isIgnorableStreamError(err)) {
            recordError(err, "http_upstream_res");
          }
          safeDestroy(clientRes);
        });

        upstreamRes.pipe(clientRes);
      }
    );

    const abortUpstream = () => {
      if (!upstreamReq.destroyed) {
        safeDestroy(upstreamReq);
      }
    };

    clientReq.on("error", abortUpstream);
    clientReq.on("aborted", abortUpstream);
    clientRes.on("error", abortUpstream);
    clientRes.on("close", () => {
      if (!clientRes.writableEnded) {
        abortUpstream();
      }
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("Upstream HTTP timeout"));
    });

    upstreamReq.on("error", (err) => {
      if (!settled) {
        settled = true;
        recordError(err, "http_upstream_req");
      }
      if (!clientRes.destroyed && !clientRes.writableEnded) {
        try {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "Content-Type": "text/plain" });
          }
          safeEnd(clientRes, `Proxy upstream error: ${err?.message || "connection failed"}`);
        } catch {
          safeDestroy(clientRes);
        }
      }
    });

    try {
      clientReq.pipe(upstreamReq);
    } catch {
      abortUpstream();
    }
  });

  server.on("clientError", (_err, socket) => {
    if (socket && !socket.destroyed && socket.writable) {
      safeEnd(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
    }
    safeDestroy(socket);
  });

  server.on("connect", (req, clientSocket, head) => {
    totalConnections += 1;
    const startedAt = Date.now();

    req.on("error", () => {});

    if (!clientSocket || clientSocket.destroyed || !clientSocket.writable) {
      safeDestroy(clientSocket);
      return;
    }

    activeSockets.add(clientSocket);
    clientSocket.on("close", () => activeSockets.delete(clientSocket));
    clientSocket.setNoDelay(true);
    clientSocket.setKeepAlive(true, 30_000);
    clientSocket.setTimeout(HANDSHAKE_TIMEOUT_MS);

    let closed = false;
    let established = false;
    let headerBuffer = Buffer.alloc(0);

    const upstreamSocket = net.connect(upstreamPort, upstreamHost);
    activeSockets.add(upstreamSocket);
    upstreamSocket.on("close", () => activeSockets.delete(upstreamSocket));
    upstreamSocket.setNoDelay(true);
    upstreamSocket.setKeepAlive(true, 30_000);
    upstreamSocket.setTimeout(HANDSHAKE_TIMEOUT_MS);

    const teardown = () => {
      if (closed) return;
      closed = true;
      headerBuffer = Buffer.alloc(0);
      safeDestroy(clientSocket);
      safeDestroy(upstreamSocket);
    };

    upstreamSocket.on("connect", () => {
      if (closed || clientSocket.destroyed || !clientSocket.writable) {
        teardown();
        return;
      }
      const connectLines = [`CONNECT ${req.url} HTTP/1.1`, `Host: ${req.url}`];
      if (authHeader) {
        connectLines.push(`Proxy-Authorization: ${authHeader}`);
      }
      connectLines.push("Proxy-Connection: Keep-Alive", "", "");
      if (!safeWrite(upstreamSocket, connectLines.join("\r\n"))) {
        teardown();
      }
    });

    const onHandshakeData = (chunk) => {
      if (closed || established) return;

      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      if (headerBuffer.length > MAX_CONNECT_HEADER_BYTES) {
        recordError(new Error("CONNECT response header overflow"), "connect_handshake");
        safeEnd(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
        teardown();
        return;
      }

      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerStr = headerBuffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = headerStr.split("\r\n")[0] || "";
      const rest = headerBuffer.subarray(headerEnd + 4);
      headerBuffer = Buffer.alloc(0);
      upstreamSocket.off("data", onHandshakeData);

      if (/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
        established = true;
        recordSuccess(Date.now() - startedAt);

        if (closed || clientSocket.destroyed || !clientSocket.writable) {
          teardown();
          return;
        }

        // Relaxa timeout ocioso após handshake para não matar WebSocket persistente do WhatsApp Web
        upstreamSocket.setTimeout(IDLE_TUNNEL_TIMEOUT_MS);
        clientSocket.setTimeout(IDLE_TUNNEL_TIMEOUT_MS);

        if (!safeWrite(clientSocket, "HTTP/1.1 200 Connection Established\r\n\r\n")) {
          teardown();
          return;
        }
        if (head && head.length > 0 && !safeWrite(upstreamSocket, head)) {
          teardown();
          return;
        }
        if (rest.length > 0 && !safeWrite(clientSocket, rest)) {
          teardown();
          return;
        }

        try {
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        } catch {
          teardown();
        }
      } else {
        recordError(new Error(statusLine || "CONNECT rejected"), "connect_status");
        safeEnd(clientSocket, `${statusLine || "HTTP/1.1 502 Bad Gateway"}\r\n\r\n`);
        teardown();
      }
    };

    upstreamSocket.on("data", onHandshakeData);

    upstreamSocket.on("error", (err) => {
      if (!closed && (!established || !isIgnorableStreamError(err))) {
        recordError(err, "connect_upstream");
      }
      if (!established) {
        safeEnd(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      teardown();
    });

    upstreamSocket.on("timeout", () => {
      if (!established && !closed) {
        recordError(new Error("CONNECT upstream timeout"), "connect_timeout");
        safeEnd(clientSocket, "HTTP/1.1 504 Gateway Timeout\r\n\r\n");
      }
      teardown();
    });

    upstreamSocket.on("close", teardown);

    clientSocket.on("error", () => {
      // Erros no socket local do Chromium (EPIPE/ECONNRESET ao fechar aba) nunca derrubam o processo
      teardown();
    });

    clientSocket.on("timeout", teardown);
    clientSocket.on("close", teardown);
  });

  await new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      reject(err);
    };
    server.once("error", onStartupError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onStartupError);
      server.on("error", (err) => {
        recordError(err, "tunnel_server");
      });
      resolve();
    });
  });

  const addr = server.address();
  const localPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    localUrl: `http://127.0.0.1:${localPort}`,
    localPort,
    upstreamHost,
    getHealth: () => ({
      healthy: consecutiveErrors < UNHEALTHY_CONSECUTIVE_ERRORS,
      errorCount,
      consecutiveErrors,
      totalConnections,
      activeConnections: activeSockets.size,
      lastLatencyMs,
      lastError,
      lastErrorAt,
      lastSuccessAt,
    }),
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      for (const sock of Array.from(activeSockets)) {
        safeDestroy(sock);
      }
      activeSockets.clear();
      try {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
