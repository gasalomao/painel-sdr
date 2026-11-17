/**
 * Registro in-memory de IDs de mensagens enviadas MANUALMENTE pelo painel.
 *
 * Problema: quando /api/send-message envia via Evolution, a Evolution
 * dispara um webhook com fromMe=true. O webhook não sabe se o envio veio
 * do painel ou da IA, e por padrão rotula como 'ai' quando o bot está
 * ativo — fazendo tuas mensagens aparecerem como mensagens da IA.
 *
 * Solução: quando o painel envia, registra o msgId aqui por 2 min.
 * O webhook consulta — se bate, rotula como 'human' em vez de 'ai'.
 */
import { getBrazilPhoneVariants } from "@/lib/jid-utils";

declare global {
   
  var __manualSendRegistry: Map<string, number> | undefined;
}

const TTL_MS = 5 * 60 * 1000; // 5 min — cobre delays de digitação (até 120s) + múltiplos balões/fotos

function getStore(): Map<string, number> {
  if (!globalThis.__manualSendRegistry) {
    globalThis.__manualSendRegistry = new Map();
  }
  return globalThis.__manualSendRegistry;
}

function prune(store: Map<string, number>) {
  const now = Date.now();
  for (const [k, expiresAt] of store) {
    if (expiresAt <= now) store.delete(k);
  }
}

export function registerManualSend(msgId: string) {
  if (!msgId) return;
  const store = getStore();
  prune(store);
  store.set(msgId, Date.now() + TTL_MS);
}

export function isManualSend(msgId: string): boolean {
  if (!msgId) return false;
  const store = getStore();
  prune(store);
  return store.has(msgId);
}

/* ============================================================
   REGISTRO DE ENVIOS DA IA
   ------------------------------------------------------------
   Mesma ideia, pro caminho oposto: quando o AGENTE de IA envia
   uma mensagem, registra o msgId aqui. O webhook, ao receber o
   echo fromMe, usa isto pra saber se foi a PRÓPRIA IA (não
   pausa) ou um HUMANO digitando no celular/painel (aí sim
   pausa a IA, pra não responderem juntos).
   ============================================================ */
declare global {

  var __aiSendRegistry: Map<string, number> | undefined;
}

function getAiStore(): Map<string, number> {
  if (!globalThis.__aiSendRegistry) {
    globalThis.__aiSendRegistry = new Map();
  }
  return globalThis.__aiSendRegistry;
}

export function registerAiSend(msgId: string) {
  if (!msgId) return;
  const store = getAiStore();
  prune(store);
  store.set(msgId, Date.now() + TTL_MS);
}

export function isAiSend(msgId: string): boolean {
  if (!msgId) return false;
  const store = getAiStore();
  prune(store);
  return store.has(msgId);
}

/* ============================================================
   REGISTRO DE ENVIOS AUTOMÁTICOS PENDENTES (EVITA RACE CONDITION)
   ------------------------------------------------------------
   Quando a Evolution envia a mensagem, o webhook echo com fromMe=true
   pode chegar ANTES de salvarmos a mensagem no banco (e chamarmos
   registerAiSend). Para evitar que esse lag temporário seja rotulado
   como envio humano (o que pausaria a IA), registramos a intenção
   de envio pendente antes de disparar o sendMessage.
   ============================================================ */
declare global {
  var __pendingAutomatedSends: Map<string, number> | undefined;
}

function getPendingAutomatedStore(): Map<string, number> {
  if (!globalThis.__pendingAutomatedSends) {
    globalThis.__pendingAutomatedSends = new Map();
  }
  return globalThis.__pendingAutomatedSends;
}

function getNormText(t: string): string {
  return (t || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 30);
}

function jidVariantsForPending(remoteJid: string): string[] {
  const clean = remoteJid.replace("@s.whatsapp.net", "");
  if (remoteJid.includes("@lid") || remoteJid.includes("@g.us")) {
    return [clean];
  }
  const set = new Set<string>([clean]);
  for (const digits of getBrazilPhoneVariants(remoteJid)) {
    if (digits) set.add(digits);
  }
  return Array.from(set);
}

export function registerPendingAutomatedSend(instanceName: string, remoteJid: string, text: string) {
  if (!instanceName || !remoteJid || !text) return;
  const store = getPendingAutomatedStore();
  prune(store);
  const norm = getNormText(text);
  const expiresAt = Date.now() + TTL_MS;
  for (const jidKey of jidVariantsForPending(remoteJid)) {
    store.set(`${instanceName}:${jidKey}:${norm}`, expiresAt);
  }
}

export function isPendingAutomatedSend(instanceName: string, remoteJid: string, text: string): boolean {
  if (!instanceName || !remoteJid || !text) return false;
  const store = getPendingAutomatedStore();
  prune(store);
  const norm = getNormText(text);
  const variants = jidVariantsForPending(remoteJid);
  let matched = false;
  for (const jidKey of variants) {
    const key = `${instanceName}:${jidKey}:${norm}`;
    if (store.has(key)) {
      store.delete(key);
      matched = true;
    }
  }
  return matched;
}

/* ============================================================
   REGISTRO DE MÍDIAS AUTOMÁTICAS PENDENTES (fotos de produto/catálogo)
   ============================================================ */
declare global {
  var __pendingAutomatedMedia: Map<string, number> | undefined;
}

function getPendingMediaStore(): Map<string, number> {
  if (!globalThis.__pendingAutomatedMedia) {
    globalThis.__pendingAutomatedMedia = new Map();
  }
  return globalThis.__pendingAutomatedMedia;
}

export function registerPendingAutomatedMedia(instanceName: string, remoteJid: string): void {
  if (!instanceName || !remoteJid) return;
  const store = getPendingMediaStore();
  prune(store);
  const expiresAt = Date.now() + TTL_MS;
  for (const jidKey of jidVariantsForPending(remoteJid)) {
    store.set(`${instanceName}:${jidKey}`, expiresAt);
  }
}

export function isPendingAutomatedMedia(instanceName: string, remoteJid: string): boolean {
  if (!instanceName || !remoteJid) return false;
  const store = getPendingMediaStore();
  prune(store);
  let matched = false;
  for (const jidKey of jidVariantsForPending(remoteJid)) {
    const key = `${instanceName}:${jidKey}`;
    if (store.has(key)) {
      store.delete(key);
      matched = true;
    }
  }
  return matched;
}

/* ============================================================
   REGISTRO DE ENVIOS DO AQUECEDOR (Warmup)
   ------------------------------------------------------------
   Garante que mensagens, áudios, vCards e reações disparados pelo
   motor de aquecimento sejam reconhecidos imediatamente no webhook
   mesmo que o chip ainda não tenha phone_number persistido no DB.
   ============================================================ */
declare global {
  var __warmupSendRegistry: Map<string, number> | undefined;
}

const WARMUP_TTL_MS = 10 * 60 * 1000;

function getWarmupStore(): Map<string, number> {
  if (!globalThis.__warmupSendRegistry) {
    globalThis.__warmupSendRegistry = new Map();
  }
  return globalThis.__warmupSendRegistry;
}

export function registerWarmupSend(msgId?: string | null): void {
  if (!msgId) return;
  const store = getWarmupStore();
  prune(store);
  store.set(msgId, Date.now() + WARMUP_TTL_MS);
}

export function isWarmupSend(msgId?: string | null): boolean {
  if (!msgId) return false;
  const store = getWarmupStore();
  prune(store);
  return store.has(msgId);
}

