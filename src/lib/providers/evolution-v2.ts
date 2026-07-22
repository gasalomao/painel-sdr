import type { WhatsAppProvider, SendResult, MediaData, ConnectionStatus, QRCodeResult } from "./types";
import { evolution } from "@/lib/evolution";

/**
 * Provedor oficial para Evolution API v2 (Node.js/Baileys).
 * Implementa a interface unificada WhatsAppProvider.
 */
export const evolutionV2: WhatsAppProvider = {
  name: "evolution",

  async sendText(remoteJid: string, text: string, instanceName: string): Promise<SendResult> {
    try {
      const res = await evolution.sendMessage(remoteJid, text, instanceName);
      const msgId = res?.key?.id || res?.messageId || res?.id || res?.data?.key?.id;
      return { ok: true, messageId: msgId, status: "sent" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async sendMedia(remoteJid: string, caption: string, media: MediaData, instanceName: string): Promise<SendResult> {
    try {
      const res = await evolution.sendMedia(remoteJid, caption, media, instanceName);
      const msgId = res?.key?.id || res?.messageId || res?.id || res?.data?.key?.id;
      return { ok: true, messageId: msgId, status: "sent" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },

  async getStatus(instanceName: string): Promise<ConnectionStatus> {
    try {
      const res = await evolution.getStatus(instanceName);
      return { state: res.state as ConnectionStatus["state"], data: res.data };
    } catch (e: any) {
      if (e.message?.includes("404") || e.message?.includes("not_found")) {
        return { state: "not_found" };
      }
      return { state: "unknown" };
    }
  },

  async getQR(instanceName: string): Promise<QRCodeResult> {
    try {
      const res = await evolution.connect(instanceName);
      return {
        qr: res?.qrcode?.code || res?.code,
        base64: res?.qrcode?.base64 || res?.base64,
        pairingCode: res?.pairingCode,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  },

  async checkNumbers(numbers: string[], instanceName: string): Promise<Record<string, boolean>> {
    try {
      return await evolution.checkWhatsAppNumbers(numbers, instanceName);
    } catch {
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
      return await evolution.checkWhatsAppNumbersDetailed(numbers, instanceName);
    } catch {
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
      return await evolution.fetchProfilePicture(remoteJid, instanceName);
    } catch {
      return null;
    }
  },
};
