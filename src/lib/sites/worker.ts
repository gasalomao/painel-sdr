import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiEmptyResponseError, openRouterChatWithFailover, ProviderHttpError, type OpenRouterResponse } from "@/lib/ai-provider";
import { logTokenUsage } from "@/lib/token-usage";
import { WebsiteAgentRuntime, type WebsiteAgentDependencies } from "./agent";
import { createSiteBuildProvider, SITE_PROVIDER_NOT_CONFIGURED } from "./build-provider";
import { createSiteDeploymentProvider, resumeSiteDeployment } from "./deployment-provider";
import { listWebsiteModels } from "./models";
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
    async chat(models, body, signal) {
      if (models.length !== 1) throw new Error("A chamada exige uma única reserva de modelo.");
      const model = models[0].id;
      let response: OpenRouterResponse;
      if (model.startsWith("gemini:")) {
        const { getAiKeys } = await import("@/lib/ai-keys");
        const keys = await getAiKeys();
        const cleanModel = model.replace(/^gemini:/, "");
        if (keys?.gemini) {
          const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${keys.gemini}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...body, model: cleanModel, stream: false }),
            signal,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
          }
          response = json;
        } else {
          response = await openRouterChatWithFailover({ ...body, model: `google/${cleanModel}`, stream: false }, { signal, maxAttempts: 1, attemptBudget: { remaining: 1 } });
        }
      } else if (model.startsWith("gateway:")) {
        const cleanModel = model.replace(/^gateway:/, "");
        const { resolveGatewayCreds, gatewayChatWithFailover } = await import("@/lib/ai-provider");
        const creds = await resolveGatewayCreds({}, cleanModel);
        if (!creds.baseUrl) {
          throw new Error("Gateway de assinatura indisponível: configure uma conexão de gateway em Configurações.");
        }
        response = await gatewayChatWithFailover(cleanModel, { ...body, model: cleanModel, stream: false }, {
          baseUrl: creds.baseUrl,
          apiKey: creds.apiKey,
          endpointId: creds.endpointId,
        }, { allowEmptyContent: Boolean((body as Record<string, unknown>)?.tools) });
      } else {
        const cleanModel = model.replace(/^openrouter:/, "");
        response = await openRouterChatWithFailover({ ...body, model: cleanModel, stream: false }, { signal, maxAttempts: 1, attemptBudget: { remaining: 1 }, allowEmptyContent: Boolean((body as Record<string, unknown>)?.tools) });
      }
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      return { model, response, usage: { promptTokens, completionTokens, totalTokens: Math.max(response.usage?.total_tokens ?? 0, promptTokens + completionTokens), attempts: response.usage?.attempts, estimated: response.usage?.attempts?.some((attempt: { estimated?: boolean }) => attempt.estimated) } };
    },
    async load(run) {
      const { getSelectedAssets } = await import("./assets");
      const [project, files, settings, skills, assets] = await Promise.all([
        getProject(run.client_id, run.project_id), getFiles(run.client_id, run.project_id),
        getWebsiteSettings(), getEffectiveSkills(run.client_id), getSelectedAssets(run.client_id, run.project_id, run.asset_ids),
      ]);
      if (!project.current_revision_id) throw new Error("Checkpoint inicial ausente. Crie uma revisão antes da execução.");
      const { data, error } = await db.from("website_messages").select("role,content,run_id")
        .eq("client_id", run.client_id).eq("project_id", run.project_id).in("role", ["user", "assistant"])
        .order("created_at", { ascending: false }).limit(20);
      databaseError(error);
      const effectiveFiles = Object.keys(files).length ? files : getCleanStarterFiles(project);
      const activeSkills = resolveActiveWebsiteSkills(project, skills, run.prompt);
      return {
        project, files: effectiveFiles, assets, settings, activeSkills,
        models: await listWebsiteModels(settings), systemPrompt: composeWebsitePrompt(project, skills, settings.creative_prompt, run.prompt, effectiveFiles),
        history: (data ?? []).filter((message) => message.run_id !== run.id).reverse().map((message) => ({ role: message.role as "user" | "assistant", content: String(message.content).slice(0, 4000) })),
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
      const outcomes = await Promise.allSettled([
        (async () => {
          const safeUsage = usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          const { data, error } = await db.rpc("website_settle_tokens", {
            p_client_id: run.client_id, p_project_id: run.project_id, p_run_id: run.id, p_worker_id: workerId,
            p_reservation_id: reservationId, p_usage: safeUsage, p_model: model, p_complete: complete,
          });
          databaseError(error);
          if (data !== reservationId) throw new Error("Contabilização de tokens não confirmada.");
        })(),
        (async () => {
          const { error } = await db.from("website_messages").insert({ client_id: run.client_id, project_id: run.project_id, run_id: run.id, role: "system", content: JSON.stringify({ usage, model, reservation_id: reservationId, complete }) });
          databaseError(error);
        })(),
        ...(usage ? (usage.attempts?.length ? usage.attempts : [{ ...usage, model, provider: (model.startsWith("gateway:") ? "gateway" : model.startsWith("gemini:") ? "gemini" : "openrouter") as any }]).map((attempt) =>
          logTokenUsage({ source: "other", sourceId: run.id, sourceLabel: "Site Studio", clientId: run.client_id, model: attempt.model, provider: (model.startsWith("gateway:") ? "Gateway" : model.startsWith("gemini:") ? "Gemini" : "OpenRouter"), promptTokens: attempt.promptTokens, completionTokens: attempt.completionTokens, totalTokens: attempt.totalTokens, metadata: { feature: "site-studio", project_id: run.project_id, run_id: run.id, reservation_id: reservationId, estimated: attempt.estimated ?? false } })
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
      await check(run);
      const provider = Object.assign({ configured: () => Boolean(process.env.E2B_API_KEY && process.env.E2B_SITE_TEMPLATE_ID) }, createSiteBuildProvider());
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
  const heartbeat = async () => {
    await deps.check(run);
    const { data, error } = await db.from("website_runs").update({ lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(), updated_at: new Date().toISOString() })
      .eq("client_id", run.client_id).eq("project_id", run.project_id).eq("id", run.id).eq("worker_id", workerId)
      .eq("cancel_requested", false).in("status", activeStatuses).gt("lease_expires_at", new Date().toISOString()).select("id").maybeSingle();
    databaseError(error);
    if (!data) throw new WebsiteLeaseLost();
  };
  const timer = setInterval(() => {
    if (checking || signal.aborted || completed) return;
    checking = heartbeat().catch((error: unknown) => controller.abort(error)).finally(() => { checking = undefined; });
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
