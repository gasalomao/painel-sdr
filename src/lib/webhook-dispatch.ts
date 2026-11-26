/**
 * Dispatcher com orçamento de tempo para chamadas webhook -> /api/agent/process.
 *
 * Em produção (Node.js server contínuo), impede que buffers longos ou múltiplas
 * tool calls ultrapassem o timeout de ~30s da Evolution API / WhatsApp Cloud,
 * evitando retries duplicados do webhook enquanto o turno termina em segundo plano.
 * Em ambiente de testes (Vitest), sempre aguarda a conclusão determinística.
 */

const DEFAULT_WEBHOOK_DISPATCH_BUDGET_MS = 20_000;

export async function dispatchAgentTurnBounded(
  invoke: () => Promise<unknown>,
  budgetMs = DEFAULT_WEBHOOK_DISPATCH_BUDGET_MS,
): Promise<{ timedOut: boolean }> {
  const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (isTestEnv || budgetMs <= 0) {
    await invoke();
    return { timedOut: false };
  }

  let finished = false;
  const runPromise = Promise.resolve()
    .then(() => invoke())
    .finally(() => {
      finished = true;
    });

  // Evita UnhandledRejection caso o turno falhe depois do deadline HTTP do webhook
  runPromise.catch((err) => {
    console.warn("[webhook-dispatch] Erro pós-deadline no turno do agente:", err instanceof Error ? err.message : err);
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadlinePromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });

  const outcome = await Promise.race([
    runPromise.then(() => "done" as const),
    deadlinePromise,
  ]);

  if (timer) clearTimeout(timer);
  return { timedOut: outcome === "timeout" && !finished };
}
