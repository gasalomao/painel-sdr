import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Credenciais do Supabase não encontradas no ambiente (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const { startAutonomousSiteWorker } = await import("../src/lib/sites/autonomous-worker-engine");
    await startAutonomousSiteWorker(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

void main().catch((err: unknown) => {
  console.error("[autonomous-site-worker] Falha crítica de inicialização:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
