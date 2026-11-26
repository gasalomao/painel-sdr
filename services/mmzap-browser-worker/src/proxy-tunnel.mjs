import http from "node:http";
import net from "node:net";

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
      ? `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`
      : null;

  const activeSockets = new Set();

  const server = http.createServer((clientReq, clientRes) => {
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
        timeout: 20_000,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    );

    upstreamReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }
      clientRes.end(`Proxy upstream error: ${err.message}`);
    });

    clientReq.pipe(upstreamReq);
  });

  server.on("connect", (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    clientSocket.on("close", () => activeSockets.delete(clientSocket));

    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const connectLines = [
        `CONNECT ${req.url} HTTP/1.1`,
        `Host: ${req.url}`,
      ];
      if (authHeader) {
        connectLines.push(`Proxy-Authorization: ${authHeader}`);
      }
      connectLines.push("Proxy-Connection: Keep-Alive", "", "");
      upstreamSocket.write(connectLines.join("\r\n"));
    });

    activeSockets.add(upstreamSocket);
    upstreamSocket.on("close", () => activeSockets.delete(upstreamSocket));
    upstreamSocket.setTimeout(60_000);
    clientSocket.setTimeout(60_000);

    let established = false;
    let headerBuffer = Buffer.alloc(0);

    upstreamSocket.on("data", (chunk) => {
      if (established) {
        clientSocket.write(chunk);
        return;
      }

      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerStr = headerBuffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = headerStr.split("\r\n")[0] || "";
      const rest = headerBuffer.subarray(headerEnd + 4);

      if (/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
        established = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) upstreamSocket.write(head);
        if (rest.length > 0) clientSocket.write(rest);
        clientSocket.pipe(upstreamSocket);
      } else {
        clientSocket.end(`${statusLine}\r\n\r\n`);
        upstreamSocket.destroy();
      }
    });

    const cleanup = () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };

    upstreamSocket.on("error", cleanup);
    upstreamSocket.on("timeout", cleanup);
    clientSocket.on("error", cleanup);
    clientSocket.on("timeout", cleanup);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const localPort = typeof addr === "object" && addr ? addr.port : 0;

  return {
    localUrl: `http://127.0.0.1:${localPort}`,
    localPort,
    upstreamHost,
    close: async () => {
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {}
      }
      activeSockets.clear();
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
