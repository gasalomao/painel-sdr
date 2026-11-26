/**
 * Fila persistente leve (via `app_settings`) para ações atrasadas do aquecimento:
 * confirmação de leitura (blue ticks) e reações humanas com delay de segundos/minutos.
 *
 * Evita perda de sinais comportamentais quando o container reinicia entre o envio
 * da mensagem e o atraso orgânico do tique azul/reação, sem criar novas tabelas.
 */

import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import { registerWarmupSend } from "@/lib/manual-send-registry";
import { logWarmupAction } from "./warmup-engine";
import { pruneMapToLimit } from "./warmup-phone-memory";

const PENDING_ACTIONS_PREFIX = "warmup_pending_actions_";
const MAX_ACTION_AGE_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_TENANT = 120;

export interface PendingWarmupAction {
  id: string;
  type: "read" | "react";
  dueAt: number;
  createdAt: number;
  actorInstance: string;
  peerInstance: string;
  actorPhone: string;
  peerPhone: string;
  targetJid: string;
  messageId: string;
  delayMs: number;
  emoji?: string;
}

const _tenantPendingQueues = new Map<string, Promise<unknown>>();
const _knownPendingTenants = new Set<string>();
const _bootRecoveredTenants = new Set<string>();

export function resetPendingWarmupActionsForTests(): void {
  _knownPendingTenants.clear();
  _bootRecoveredTenants.clear();
}

export function shouldCheckPendingWarmupActions(clientId: string): boolean {
  if (_knownPendingTenants.has(clientId)) return true;
  const isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (isTestEnv) return false;
  return !_bootRecoveredTenants.has(clientId);
}

function enqueuePendingOp<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
  pruneMapToLimit(_tenantPendingQueues, 2000);
  const prev = _tenantPendingQueues.get(clientId) || Promise.resolve();
  const next = prev.then(fn, fn);
  _tenantPendingQueues.set(clientId, next);
  return next;
}

async function readPendingActions(clientId: string): Promise<PendingWarmupAction[]> {
  try {
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", `${PENDING_ACTIONS_PREFIX}${clientId}`)
      .maybeSingle();

    if (!data?.value) return [];
    const parsed = JSON.parse(String(data.value));
    return Array.isArray(parsed) ? (parsed as PendingWarmupAction[]) : [];
  } catch {
    return [];
  }
}

async function writePendingActions(clientId: string, actions: PendingWarmupAction[]): Promise<void> {
  try {
    const trimmed = actions.slice(-MAX_PENDING_PER_TENANT);
    await supabaseAdmin
      .from("app_settings")
      .upsert(
        {
          key: `${PENDING_ACTIONS_PREFIX}${clientId}`,
          value: JSON.stringify(trimmed),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
  } catch {
    /* persistência best-effort */
  }
}

export async function enqueuePendingWarmupAction(
  clientId: string,
  action: Omit<PendingWarmupAction, "id" | "createdAt">,
): Promise<PendingWarmupAction> {
  const now = Date.now();
  const item: PendingWarmupAction = {
    id: `wpa_${now.toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    createdAt: now,
    ...action,
  };

  await enqueuePendingOp(clientId, async () => {
    const list = await readPendingActions(clientId);
    const alive = list.filter((a) => a && now - (a.createdAt || 0) <= MAX_ACTION_AGE_MS);
    alive.push(item);
    await writePendingActions(clientId, alive);
    _knownPendingTenants.add(clientId);
  });

  return item;
}

async function executeSinglePendingAction(clientId: string, item: PendingWarmupAction): Promise<boolean> {
  if (item.type === "read") {
    try {
      await evolution.markMessageAsRead(
        [{ remoteJid: item.targetJid, id: item.messageId, fromMe: false }],
        item.actorInstance
      );
      await logWarmupAction({
        client_id: clientId,
        sender_instance: item.actorInstance,
        receiver_instance: item.peerInstance,
        sender_phone: item.actorPhone,
        receiver_phone: item.peerPhone,
        message_text: `Visualizou e confirmou leitura da mensagem (tiques azuis exibidos após ${Math.round(item.delayMs / 1000)}s)`,
        action_type: "presence",
        details: { message_id: item.messageId, delay_ms: item.delayMs, read_receipt: true },
      });
      return true;
    } catch (err: unknown) {
      console.error(
        `[WARMUP] Erro ao marcar como lido em ${item.actorInstance}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  if (item.type === "react" && item.emoji) {
    try {
      const reactRes = (await evolution.sendReaction(
        item.targetJid,
        item.messageId,
        item.emoji,
        item.actorInstance,
        false
      )) as { key?: { id?: string }; id?: string; data?: { key?: { id?: string } } } | null;
      registerWarmupSend(reactRes?.key?.id || reactRes?.data?.key?.id || reactRes?.id);
      await logWarmupAction({
        client_id: clientId,
        sender_instance: item.actorInstance,
        receiver_instance: item.peerInstance,
        sender_phone: item.actorPhone,
        receiver_phone: item.peerPhone,
        message_text: `Reagiu com ${item.emoji} à mensagem anterior`,
        action_type: "reaction",
        details: { reaction: item.emoji, target_msg_id: item.messageId, delay_ms: item.delayMs },
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Remove atomicamente uma ação pelo id e a executa apenas se ainda estava pendente
 * (impede dupla execução entre timer em RAM e drenagem pós-restart no worker).
 */
export async function claimAndRunPendingWarmupAction(
  clientId: string,
  actionId: string,
): Promise<boolean> {
  let claimed: PendingWarmupAction | null = null;
  const now = Date.now();

  await enqueuePendingOp(clientId, async () => {
    const list = await readPendingActions(clientId);
    const idx = list.findIndex((a) => a.id === actionId);
    if (idx < 0) return;
    claimed = list[idx];
    const remaining = list.filter((a, i) => i !== idx && now - (a.createdAt || 0) <= MAX_ACTION_AGE_MS);
    await writePendingActions(clientId, remaining);
    if (remaining.length === 0) _knownPendingTenants.delete(clientId);
  });

  if (!claimed) return false;
  return executeSinglePendingAction(clientId, claimed);
}

/**
 * Drena todas as ações vencidas (`dueAt <= nowMs`) de um tenant (chamado pelo worker).
 */
export async function drainDuePendingWarmupActions(
  clientId: string,
  nowMs = Date.now(),
): Promise<number> {
  _bootRecoveredTenants.add(clientId);
  const due: PendingWarmupAction[] = [];

  await enqueuePendingOp(clientId, async () => {
    const list = await readPendingActions(clientId);
    if (list.length === 0) {
      _knownPendingTenants.delete(clientId);
      return;
    }

    const future: PendingWarmupAction[] = [];
    let dirty = false;
    for (const item of list) {
      if (!item || nowMs - (item.createdAt || 0) > MAX_ACTION_AGE_MS) {
        dirty = true;
        continue;
      }
      if (item.dueAt <= nowMs) {
        due.push(item);
        dirty = true;
      } else {
        future.push(item);
      }
    }
    if (dirty) {
      await writePendingActions(clientId, future);
    }
    if (future.length === 0) {
      _knownPendingTenants.delete(clientId);
    } else {
      _knownPendingTenants.add(clientId);
    }
  });

  let executed = 0;
  for (const item of due.slice(0, 25)) {
    const ok = await executeSinglePendingAction(clientId, item);
    if (ok) executed++;
  }
  return executed;
}
