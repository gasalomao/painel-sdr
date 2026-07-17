/**
 * Evolution GO — provedor de WhatsApp (Go/whatsmeow).
 *
 * Parte da migração de Evolution API (Node.js/Baileys) → Evolution GO (Go/whatsmeow).
 * Implementa a interface WhatsAppProvider. O channel.ts roteia pra este provedor
 * quando `channel_connections.provider === "evolution_go"`.
 *
 * Diferenças-chave vs Evolution API:
 *   - Endpoints: /send/text (GO) vs /message/sendText (API legada)
 *   - Auth: header `apikey` (igual nos dois)
 *   - Status: /connect/status (GO) vs /instance/connectionState (legada)
 *   - QR: /connect/qr (GO) vs /instance/qrcode (legada)
 *   - Payload: shape similar mas não idêntico (validar campo a campo)
 *
 * Docs: docs/research/EVOLUTION_GO.md
 * Config: EVOLUTION_GO_URL + EVOLUTION_GO_KEY no .env
 */

import type { WhatsAppProvider, SendResult, MediaData, ConnectionStatus, QRCodeResult } from "./types";

// Config — lida do DB (app_settings) ou env. Igual ao pattern do evolution.ts.
let GO_URL = process.env.EVOLUTION_GO_URL || "";
let GO_KEY = process.env.EVOLUTION_GO_KEY || "";
let _cfgLoadedAt = 0;
const CFG_TTL = 30_000;

async function loadConfig(): Promise<void> {
  if (GO_URL && GO_KEY && Date.now() - _cfgLoadedAt < CFG_TTL) return;
  try {
    const { supabaseAdmin } = await import("@/lib/supabase_admin");
    if (!supabaseAdmin) return;
    const { data } = await supabaseAdmin
      .from("app_settings")
      .select("key, value")
      .in("key", ["evolution_go_url", "evolution_go_key"]);
    if (data) {
      for (const row of data) {
        if (row.key === "evolution_go_url" && row.value) GO_URL = row.value;
        if (row.key === "evolution_go_key" && row.value) GO_KEY = row.value;
      }
    }
    // Fallback env se DB não tem.
    if (!GO_URL) GO_URL = process.env.EVOLUTION_GO_URL || "";
    if (!GO_KEY) GO_KEY = process.env.EVOLUTION_GO_KEY || "";
    _cfgLoadedAt = Date.now();
  } catch {
    // sem DB — usa env
  }
}

export function invalidateEvolutionGoCache(): void {
  _cfgLoadedAt = 0;
}

/**
 * Fetch pro Evolution GO. Headers iguais ao legado: `apikey`.
 * As rotas do GO são /send/text, /connect/status etc (mais RESTful).
 */
async function goFetch(path: string, body?: unknown): Promise<any> {
  await loadConfig();
  if (!GO_URL) throw new Error("Evolution GO não configurado. Defina EVOLUTION_GO_URL nas configurações.");
  const url = GO_URL.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: GO_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.error || json?.response?.message || `Evolution GO HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return json;
}

/**
 * Resolve o instanceId do Evolution GO. O GO usa um UUID como instanceId
 * interno além do nome. Buscamos na lista de instâncias.
 */
async function resolveInstanceId(instanceName: string): Promise<string> {
  const all = await goFetch("/instance/all");
  const list = Array.isArray(all) ? all : (all?.instances || all?.data || []);
  const match = list.find((i: any) => {
    const name = i.instanceName || i.name || i.instance?.instanceName || i.instance?.name;
    return name === instanceName;
  });
  // O GO usa o instanceName direto nas rotas (não precisa do UUID).
  return instanceName;
}

// ============================================================================
// Implementação da interface
// ============================================================================

export const evolutionGo: WhatsAppProvider = {
  name: "evolution_go",

  async sendText(remoteJid: string, text: string, instanceName: string): Promise<SendResult> {
    try {
      const res = await goFetch("/send/text", {
        instance: instanceName,
        number: remoteJid.replace(/@s\.whatsapp\.net$/, ""),
        text,
      });
      const msgId = res?.key?.id || res?.messageId || res?.id;
      return { ok: true, messageId: msgId, status: "sent" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async sendMedia(remoteJid: string, caption: string, media: MediaData, instanceName: string): Promise<SendResult> {
    try {
      // O GO unifica mídia em /send/media com campo "mediatype".
      const res = await goFetch("/send/media", {
        instance: instanceName,
        number: remoteJid.replace(/@s\.whatsapp\.net$/, ""),
        mediatype: media.type,
        base64: media.base64,
        fileName: media.fileName || `file.${media.type === "image" ? "jpg" : media.type === "audio" ? "mp3" : "bin"}`,
        mimetype: media.mimetype || "application/octet-stream",
        caption: caption || "",
      });
      const msgId = res?.key?.id || res?.messageId || res?.id;
      return { ok: true, messageId: msgId, status: "sent" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async getStatus(instanceName: string): Promise<ConnectionStatus> {
    try {
      const res = await goFetch(`/connect/status`, { instance: instanceName });
      // O GO retorna { status: "open"|"close"|"connecting", ... }
      let state = (res?.status || res?.state || res?.instance?.status || "unknown").toLowerCase();
      if (state === "connected") state = "open";
      if (state === "disconnected") state = "close";
      return { state: state as ConnectionStatus["state"], data: res };
    } catch (e: any) {
      if (e.message.includes("404") || e.message.includes("not found")) {
        return { state: "not_found" };
      }
      return { state: "unknown" };
    }
  },

  async getQR(instanceName: string): Promise<QRCodeResult> {
    try {
      const res = await goFetch("/connect", { instance: instanceName });
      // O GO retorna { qrcode: { code: "...", base64: "..." } } ou pairing code.
      return {
        qr: res?.qrcode?.code || res?.qrcode,
        base64: res?.qrcode?.base64,
        pairingCode: res?.pairingCode,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  },

  async checkNumbers(numbers: string[], instanceName: string): Promise<Record<string, boolean>> {
    try {
      const res = await goFetch("/chat/whatsapp", {
        instance: instanceName,
        numbers: numbers.map(n => n.replace(/\D/g, "")),
      });
      // O GO retorna array de { jid, exists }
      const arr = Array.isArray(res) ? res : (res?.data || []);
      const map: Record<string, boolean> = {};
      for (const item of arr) {
        const num = (item.number || item.jid || "").replace(/\D/g, "");
        map[num] = !!item.exists;
      }
      return map;
    } catch {
      // Fallback: presume que existem (não bloqueia disparo).
      const map: Record<string, boolean> = {};
      for (const n of numbers) map[n.replace(/\D/g, "")] = true;
      return map;
    }
  },

  async checkNumbersDetailed(
    numbers: string[],
    instanceName: string
  ): Promise<Record<string, { exists: boolean; jid: string | null }>> {
    try {
      const res = await goFetch("/chat/whatsapp", {
        instance: instanceName,
        numbers: numbers.map(n => n.replace(/\D/g, "")),
      });
      const arr = Array.isArray(res) ? res : (res?.data || []);
      const map: Record<string, { exists: boolean; jid: string | null }> = {};
      for (const item of arr) {
        const num = (item.number || item.jid || "").replace(/\D/g, "");
        map[num] = { exists: !!item.exists, jid: item.jid || (item.exists ? `${num}@s.whatsapp.net` : null) };
      }
      return map;
    } catch {
      // Fallback
      const map: Record<string, { exists: boolean; jid: string | null }> = {};
      for (const n of numbers) {
        const d = n.replace(/\D/g, "");
        if (d) map[d] = { exists: true, jid: `${d}@s.whatsapp.net` };
      }
      return map;
    }
  },

  async fetchProfilePicture(remoteJid: string, instanceName: string): Promise<string | null> {
    try {
      const res = await goFetch("/message/avatar", {
        instance: instanceName,
        number: remoteJid.replace(/@s\.whatsapp\.net$/, ""),
      });
      return res?.pictureUrl || res?.url || res?.avatar || null;
    } catch {
      return null;
    }
  },
};
