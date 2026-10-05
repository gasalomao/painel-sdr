import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  if (process.env.SITES_WORKER_ENABLED !== "true") throw new Error("SITES_WORKER_ENABLED deve ser true.");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("READY — AWAITING CREDENTIALS: Supabase.");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Worker encerrado."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const { startWebsiteWorker } = await import("../src/lib/sites/worker");
    await startWebsiteWorker(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

void main().catch((err: unknown) => {
  console.error("[sites-worker] Inicialização falhou. Verifique env, dependências e migration do Site Studio.");
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
