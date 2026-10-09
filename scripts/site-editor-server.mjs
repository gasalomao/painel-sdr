import { resolve } from "node:path";
import { createServer } from "vite";

// Editor fixture host with Next.js stub injection.
const server = await createServer({
  configFile: false,
  envFile: false,
  publicDir: false,
  plugins: [{ name: "editor-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Editor sintético</title></head><body><div id="root"></div><script type="module" src="/scripts/site-editor-fixture.tsx"></script></body></html>');
    });
  } }],
  resolve: { alias: { "@": resolve("src") } },
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: ["scripts/site-editor-fixture.tsx"] },
  define: { "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("") },
  server: { host: "127.0.0.1", port: 4179, strictPort: true, watch: null, fs: { strict: true } },
});
await server.listen();
const close = async () => { await server.close(); process.exit(0); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
