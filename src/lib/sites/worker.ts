import { CHECKPOINT_RECOVERY_WARNING, loadRunCheckpoint, saveRunCheckpoint } from "./run-checkpoint";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiEmptyResponseError, ProviderHttpError } from "@/lib/ai-provider";
import { logTokenUsage } from "@/lib/token-usage";
import { WebsiteAgentRuntime, type WebsiteAgentDependencies } from "./agent";
import { createSiteBuildProvider, SITE_PROVIDER_NOT_CONFIGURED } from "./build-provider";
import { createSiteDeploymentProvider, resumeSiteDeployment } from "./deployment-provider";
import { listWebsiteModels, websiteChatAttempt } from "./models";
import { parseWebsiteDesignDirection, type WebsiteDesignDirection } from "./impeccable";
import { composeWebsitePrompt, getWebsiteSettings, resolveActiveWebsiteSkills } from "./prompts";
import { databaseError, getFiles, getProject } from "./repository";
import { getSitesDb } from "./server";
import { getEffectiveSkills } from "./skills";
import { getCleanStarterFiles, getStarterFiles } from "./starter";
import type { WebsiteDeployment, WebsiteRun } from "./types";

const LEASE_MS = 120_000;
const POLL_MS = 3000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const activeStatuses = ["planning", "editing", "validating"];
export type ClaimedRun = WebsiteRun & { worker_id: string; actor_id: string };

export class WebsiteRunCancelled extends Error {
  constructor() { super("Execução cancelada."); }
}

export class WebsiteLeaseLost extends Error {
  constructor() { super("Lease da execução perdida."); }
}

function runQuery(db: SupabaseClient, run: WebsiteRun, workerId: string) {
  return db.from("website_runs").select("id,status,cancel_requested,lease_expires_at,worker_id")
    .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("id", run.id).eq("worker_id", workerId).maybeSingle();
}

export function compactHistoryMessages(
  messages: Array<{ role: string; content: unknown; run_id: string }>,
  currentRunId: string,
): Array<{ role: "user" | "assistant"; content: string }> {
  const filtered = messages.filter((m) => m.run_id !== currentRunId && (m.role === "user" || m.role === "assistant"));
  const recent = filtered.slice(0, 8).reverse();

  return recent.map((m, index) => {
    let content = String(m.content ?? "").trim();
    if (m.role === "assistant") {
      content = content.replace(/```[\s\S]*?```/g, "[código aplicado no site]");
      const isLatestAssistant = index >= recent.length - 2;
      const maxChars = isLatestAssistant ? 500 : 200;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + "...";
      }
    } else {
      if (content.length > 1000) {
        content = content.slice(0, 1000) + "...";
      }
    }
    return { role: m.role as "user" | "assistant", content };
  });
}

export function createWebsiteAgentDependencies(db: SupabaseClient, workerId: string): WebsiteAgentDependencies {
  const check: WebsiteAgentDependencies["check"] = async (run) => {
    const { data, error } = await runQuery(db, run, workerId);
    databaseError(error);
    if (data?.cancel_requested || data?.status === "cancelled") throw new WebsiteRunCancelled();
    if (!data || !activeStatuses.includes(data.status) || !data.lease_expires_at || Date.parse(data.lease_expires_at) <= Date.now()) throw new WebsiteLeaseLost();
  };
  const event: WebsiteAgentDependencies["event"] = async (run, message) => {
    await check(run);
    const { error } = await db.from("website_messages").insert({ client_id: run.client_id, project_id: run.project_id, run_id: run.id, ...message });
    databaseError(error);
  };
  return {
    check, event,
    async checkpoint(run, checkpoint) {
      await check(run);
      await saveRunCheckpoint(db, run, checkpoint, () => check(run));
    },
    async chat(models, body, signal) {
      if (models.length !== 1) throw new Error("A chamada exige uma única reserva de modelo.");
      signal.throwIfAborted();
      return websiteChatAttempt(models[0], body, signal);
    },
    async load(run) {
      const { getSelectedAssets } = await import("./assets");
      const checkpoint = await loadRunCheckpoint(db, run);
      if (checkpoint?.progress?.diagnostics.includes(CHECKPOINT_RECOVERY_WARNING)) await event(run, { role: "system", content: CHECKPOINT_RECOVERY_WARNING });
      const assetIds = [...new Set([...(checkpoint?.assetIds ?? []), ...run.asset_ids])];
      const [project, files, settings, skills, assets] = await Promise.all([
        getProject(run.client_id, run.project_id), getFiles(run.client_id, run.project_id),
        getWebsiteSettings(), getEffectiveSkills(run.client_id), getSelectedAssets(run.client_id, run.project_id, assetIds),
      ]);
      if (!project.current_revision_id) throw new Error("Checkpoint inicial ausente. Crie uma revisão antes da execução.");
      const { data, error } = await db.from("website_messages").select("role,content,run_id")
        .eq("client_id", run.client_id).eq("project_id", run.project_id).in("role", ["user", "assistant"])
        .order("created_at", { ascending: false }).limit(20);
      databaseError(error);
      const effectiveFiles = checkpoint?.files ?? (Object.keys(files).length ? files : getCleanStarterFiles(project));
      const activeSkills = resolveActiveWebsiteSkills(project, skills, run.prompt);
      // Private design direction lives in build QA. Manual editor saves create revisions without builds,
      // so walk the revision lineage (same tenant and project only) to keep the registered identity.
      let designDirection: WebsiteDesignDirection | undefined = checkpoint?.designDirection;
      let revisionId: string | null = run.base_revision_id;
      const visited = new Set<string>();
      for (let depth = 0; revisionId && !designDirection && !visited.has(revisionId) && depth < 6; depth++) {
        visited.add(revisionId);
        const priorBuild = await db.from("website_builds").select("qa").eq("client_id", run.client_id).eq("project_id", run.project_id)
          .eq("revision_id", revisionId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        databaseError(priorBuild.error);
        if (priorBuild.data?.qa?.design_direction) {
          try { designDirection = parseWebsiteDesignDirection(priorBuild.data.qa.design_direction); }
          catch { /* Legacy malformed design metadata is not an instruction source. */ }
          break;
        }
        const revision = await db.from("website_revisions").select("parent_id").eq("client_id", run.client_id).eq("project_id", run.project_id)
          .eq("id", revisionId).maybeSingle();
        databaseError(revision.error);
        revisionId = typeof revision.data?.parent_id === "string" ? revision.data.parent_id : null;
      }
      return {
        project, files: effectiveFiles, assets, settings, activeSkills, designDirection, pendingRequest: checkpoint?.request, pendingNotes: checkpoint?.notes, pendingProgress: checkpoint?.progress, pendingQaReport: checkpoint?.qaReport, budgetConsumed: checkpoint?.budgetConsumed,
        models: await listWebsiteModels(settings), systemPrompt: composeWebsitePrompt(project, skills, settings.creative_prompt, run.prompt, effectiveFiles, designDirection),
        history: compactHistoryMessages(data ?? [], run.id),
      };
    },
    async status(run, status) {
      await check(run);
      const { data, error } = await db.from("website_runs").update({ status, updated_at: new Date().toISOString() })
        .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("id", run.id).eq("worker_id", workerId)
        .eq("cancel_requested", false).in("status", activeStatuses).gt("lease_expires_at", new Date().toISOString()).select("id").maybeSingle();
      databaseError(error);
      if (!data) throw new WebsiteLeaseLost();
    },
    async reserveTokens(run, amount) {
      await check(run);
      const reservationId = randomUUID();
      const { data, error } = await db.rpc("website_reserve_tokens", {
        p_client_id: run.client_id, p_project_id: run.project_id, p_run_id: run.id, p_worker_id: workerId,
        p_reservation_id: reservationId, p_amount: amount,
      });
      databaseError(error);
      if (data !== reservationId) throw new Error("Reserva de tokens não confirmada.");
      return reservationId;
    },
    async usage(run, usage, model, reservationId, complete) {
      const settled = complete && usage !== null && !usage.estimated && !usage.attempts?.some((attempt) => attempt.estimated);
      const outcomes = await Promise.allSettled([
        (async () => {
          const safeUsage = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          const { data, error } = await db.rpc("website_settle_tokens", {
            p_client_id: run.client_id, p_project_id: run.project_id, p_run_id: run.id, p_worker_id: workerId,
            p_reservation_id: reservationId, p_usage: safeUsage, p_model: model, p_complete: settled,
          });
          databaseError(error);
          if (data !== reservationId) throw new Error("Contabilização de tokens não confirmada.");
        })(),
        (async () => {
          const { error } = await db.from("website_messages").insert({ client_id: run.client_id, project_id: run.project_id, run_id: run.id, role: "system", content: JSON.stringify({ usage, model, reservation_id: reservationId, complete: settled }) });
          databaseError(error);
        })(),
        ...(usage ? (usage.attempts?.length ? usage.attempts : [{ ...usage, model, provider: model.startsWith("gateway:") ? "gateway" : model.startsWith("gemini:") ? "gemini" : model.startsWith("nvidia:") ? "nvidia" : "openrouter" }]).map((attempt) =>
          logTokenUsage({ source: "other", sourceId: run.id, sourceLabel: "Site Studio", clientId: run.client_id, model: attempt.model,
            provider: attempt.provider === "gateway" ? "Gateway" : attempt.provider === "gemini" ? "Gemini" : attempt.provider === "nvidia" ? "NVIDIA" : "OpenRouter",
            promptTokens: attempt.promptTokens, completionTokens: attempt.completionTokens, totalTokens: attempt.totalTokens, cachedTokens: attempt.cachedTokens,
            metadata: { feature: "site-studio", project_id: run.project_id, run_id: run.id, reservation_id: reservationId, provider: attempt.provider, cached_tokens: attempt.cachedTokens ?? null, estimated: attempt.estimated ?? usage.estimated ?? false } })
        ) : []),
      ]);
      if (outcomes[0].status === "rejected") throw outcomes[0].reason;
      if (outcomes.slice(1).some((outcome) => outcome.status === "rejected")) console.error("[sites-worker] Telemetria de tokens parcialmente não registrada.");
    },
    async build(run, input, signal) {
      signal.throwIfAborted();
      await check(run);
      if (input.project.client_id !== run.client_id || input.project.id !== run.project_id) throw new Error("Projeto fora do escopo da execução.");
      const { getReferencedAssets } = await import("./assets");
      const assets = await getReferencedAssets(run.client_id, run.project_id, input.files);
      signal.throwIfAborted();
      let e2bConfigured = Boolean(process.env.E2B_API_KEY?.trim() && process.env.E2B_SITE_TEMPLATE_ID?.trim());
      if (process.env.NODE_ENV !== "test" && !e2bConfigured) {
        try {
          const dotenv = await import("dotenv");
          dotenv.config({ path: join(process.cwd(), ".env.local"), override: true });
          e2bConfigured = Boolean(process.env.E2B_API_KEY?.trim() && process.env.E2B_SITE_TEMPLATE_ID?.trim());
        } catch { /* ignore */ }
      }
      const provider = Object.assign({ configured: () => e2bConfigured }, createSiteBuildProvider());
      if (provider.configured()) {
        const { data, error } = await db.rpc("website_consume_quota", { p_client_id: run.client_id, p_metric: "builds", p_amount: 1 });
        databaseError(error);
        if (!Number.isSafeInteger(data) || data < 1) throw new Error("Quota de build não confirmada.");
      }
      signal.throwIfAborted();
      await check(run);
      return provider.build({ ...input, assets }, signal);
    },
    async complete(run, files, build, summary, modelUsed) {
      await check(run);
      const { data, error } = await db.rpc("website_complete_run", {
        p_client_id: run.client_id, p_project_id: run.project_id, p_run_id: run.id, p_worker_id: workerId,
        p_expected_revision_id: run.base_revision_id, p_files: files, p_build: build, p_summary: summary, p_model_used: modelUsed,
      });
      databaseError(error);
      if (!data) throw new WebsiteLeaseLost();
    },
  };
}

export async function claimWebsiteRun(db: SupabaseClient, workerId: string): Promise<ClaimedRun | null> {
  const { data, error } = await db.rpc("website_claim_next_run", { p_worker_id: workerId });
  databaseError(error);
  const run = (Array.isArray(data) ? data[0] : data) as ClaimedRun | null;
  if (!run?.id) return null;
  if (run.worker_id !== workerId || !activeStatuses.includes(run.status) || !run.lease_expires_at || Date.parse(run.lease_expires_at) <= Date.now()) throw new WebsiteLeaseLost();
  return run;
}

function runFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === `${SITE_PROVIDER_NOT_CONFIGURED}: nenhum modelo compatível disponível.` || message === "Nenhum modelo compatível disponível.") return "Nenhum modelo compatível disponível. Verifique os modelos e as credenciais.";
  if (message.startsWith(SITE_PROVIDER_NOT_CONFIGURED)) return SITE_PROVIDER_NOT_CONFIGURED;
  if (error instanceof AiEmptyResponseError) return "O agente retornou resposta vazia sem executar nenhuma ação.";
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return "Autenticação do provedor de IA recusada. Verifique as credenciais em Configurações.";
    if (error.status === 429) return "Limite de requisições do provedor de IA atingido. Tente novamente mais tarde.";
    if (error.status === 402) return "Saldo ou quota do provedor de IA insuficiente. Verifique sua conta.";
  }
  if ([
    "Modelo manual indisponível ou sem suporte a ferramentas.", "O agente retornou resposta vazia sem executar nenhuma ação.",
    "Limite de turnos ou saída atingido.", "Limite de saída atingido.", "Saída do modelo excede o limite.",
    "Limite de ferramentas atingido.", "Contexto da execução excede o limite.",
    "Modelo sem orçamento de contexto confiável.", "Pedido excede o orçamento de contexto do modelo.",
    "Reserva de tokens não confirmada.", "Quota de build não confirmada.", "Contabilização de tokens não confirmada.",
    "Limite do Site Studio atingido.", "Registro não encontrado.", "O projeto mudou. Atualize antes de salvar.",
    "Já existe uma execução ativa neste projeto.", "Dados inválidos.", "A concessão da execução expirou.",
    "Acesso não permitido.", "Conflito com um registro existente.", "Vínculo inválido ou registro alterado.",
    "Não foi possível persistir ou consultar os dados.", "Não foi possível carregar o projeto.", "Projeto não encontrado.",
    "QA não aprovado. A revisão anterior foi preservada.",
    "Execução interrompida sem progresso. Rascunho preservado; retome com outro modelo ou pedido mais específico.",
    "Orçamento da edição atingido. Progresso preservado; validação pendente.",
    "Orçamento da edição excedido. A revisão anterior foi preservada.",
  ].includes(message)) return message;
  return "A execução não foi concluída. Os arquivos anteriores foram preservados.";
}

async function runWithLease(
  db: SupabaseClient,
  run: ClaimedRun,
  workerId: string,
  shutdown: AbortSignal | undefined,
  body: (signal: AbortSignal, deps: WebsiteAgentDependencies) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RUN_TIMEOUT_MS), ...(shutdown ? [shutdown] : [])]);
  const deps = createWebsiteAgentDependencies(db, workerId);
  let checking: Promise<void> | undefined;
  let completed = false;
  let consecutiveFailures = 0;
  const heartbeat = async () => {
    await deps.check(run);
    const { data, error } = await db.from("website_runs").update({ lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(), updated_at: new Date().toISOString() })
      .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("id", run.id).eq("worker_id", workerId)
      .eq("cancel_requested", false).in("status", activeStatuses).gt("lease_expires_at", new Date(Date.now() - 30_000).toISOString()).select("id").maybeSingle();
    databaseError(error);
    if (!data) throw new WebsiteLeaseLost();
  };
  const timer = setInterval(() => {
    if (checking || signal.aborted || completed) return;
    checking = heartbeat().then(() => {
      consecutiveFailures = 0;
    }).catch((error: unknown) => {
      consecutiveFailures++;
      if (error instanceof WebsiteLeaseLost || signal.aborted || completed) {
        controller.abort(error);
        return;
      }
      console.warn(`[sites-worker] Heartbeat falhou (${consecutiveFailures}x):`, (error as Error)?.message || error);
      if (consecutiveFailures >= 6) {
        controller.abort(error);
      }
    }).finally(() => { checking = undefined; });
  }, POLL_MS);
  timer.unref();
  try {
    await heartbeat();
    await body(signal, deps);
    completed = true;
  } catch (error) {
    if (error instanceof WebsiteLeaseLost || signal.reason instanceof WebsiteLeaseLost) return;
    const current = await runQuery(db, run, workerId);
    if (current.error) throw new Error("Falha ao consultar encerramento da execução.");
    if (!current.data || !activeStatuses.includes(current.data.status)) return;
    const cancelled = current.data.cancel_requested || error instanceof WebsiteRunCancelled || signal.reason instanceof WebsiteRunCancelled || shutdown?.aborted;
    const message = cancelled ? "Execução cancelada." : runFailureMessage(error);
    const { data, error: updateError } = await db.from("website_runs").update({ status: cancelled ? "cancelled" : "failed", error: cancelled ? null : message, lease_expires_at: null, updated_at: new Date().toISOString() })
      .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("id", run.id).eq("worker_id", workerId)
      .eq("cancel_requested", Boolean(current.data.cancel_requested)).in("status", activeStatuses).gt("lease_expires_at", new Date().toISOString()).select("id").maybeSingle();
    databaseError(updateError);
    if (data) {
      const { error: sweepError } = await db.rpc("website_liquidate_run_reservations", { p_client_id: run.client_id, p_run_id: run.id });
      if (sweepError) console.error("[sites-worker] Reservas de tokens órfãs serão liquidadas pelo ciclo do worker.");
      const { error: messageError } = await db.from("website_messages").insert({ client_id: run.client_id, project_id: run.project_id, run_id: run.id, role: "system", content: message });
      databaseError(messageError);
    }
  } finally {
    completed = true;
    clearInterval(timer);
    await checking;
  }
}

export async function executeWebsiteRun(db: SupabaseClient, run: ClaimedRun, workerId: string, shutdown?: AbortSignal): Promise<void> {
  await runWithLease(db, run, workerId, shutdown, async (signal, deps) => {
    await new WebsiteAgentRuntime(deps).run(run, signal);
  });
}

async function recoverWebsiteDeployments(db: SupabaseClient, signal: AbortSignal): Promise<void> {
  let afterId: string | null = null;
  while (!signal.aborted) {
    try {
      if (createSiteDeploymentProvider().configured()) {
        const { data, error } = await db.rpc("website_list_recoverable_deployments", { p_after_id: afterId })
          .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        databaseError(error);
        const deployments = (data ?? []) as Pick<WebsiteDeployment, "id" | "client_id" | "project_id">[];
        afterId = deployments.length === 5 ? deployments[4].id : null;
        for (const deployment of deployments) {
          if (signal.aborted) break;
          try {
            await resumeSiteDeployment(deployment.client_id, deployment.project_id, deployment.id,
              AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]));
          } catch {
            if (!signal.aborted) console.error("[sites-worker] Publicação pendente de reconciliação; nova tentativa em ciclo posterior.");
          }
        }
      }
    } catch {
      if (!signal.aborted) console.error("[sites-worker] Falha ao consultar publicações pendentes; verifique banco e migrations.");
    }
    try { await delay(60_000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error("Falha na espera da reconciliação."); }
  }
}

export async function startWebsiteWorker(signal: AbortSignal, workerId = randomUUID()): Promise<void> {
  if (process.env.SITES_WORKER_ENABLED !== "true") throw new Error("SITES_WORKER_ENABLED deve ser true no worker separado.");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(`${SITE_PROVIDER_NOT_CONFIGURED}: Supabase do worker.`);
  const db = getSitesDb();
  const recoveryController = new AbortController();
  const recovery = recoverWebsiteDeployments(db, AbortSignal.any([signal, recoveryController.signal]));
  try {
    while (!signal.aborted) {
      try {
        const run = await claimWebsiteRun(db, workerId);
        if (run) {
          await executeWebsiteRun(db, run, workerId, signal);
          continue;
        }
      } catch {
        if (!signal.aborted) console.error("[sites-worker] Falha no ciclo; verifique migrations, banco e contratos do worker.");
      }
      try { await delay(POLL_MS, undefined, { signal }); } catch { if (!signal.aborted) throw new Error("Falha na espera do worker."); }
    }
  } finally {
    recoveryController.abort();
    await recovery;
  }
}
