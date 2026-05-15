/**
 * Evolution API v2 Integration Helper
 * Follows specs from: https://doc.evolution-api.com/v2/api-reference/
 *
 * As credenciais (URL/API Key/Instance) podem vir de duas fontes:
 *   1) tabela app_settings (chaves: evolution_url, evolution_api_key, evolution_instance)
 *      → permite trocar o servidor da Evolution sem rebuild, pela aba Configurações.
 *   2) Variáveis de ambiente EVOLUTION_API_URL/KEY/INSTANCE (fallback).
 * O DB tem precedência. Cache em memória de 15s evita 1 round-trip por request.
 */

import axios from "axios";
import https from "https";
import { createClient } from "@supabase/supabase-js";

let EVO_URL  = process.env.EVOLUTION_API_URL  || "";
let EVO_KEY  = process.env.EVOLUTION_API_KEY  || "";
// Sem default chumbado. Resolução em ordem: app_settings.evolution_instance
// → process.env.EVOLUTION_INSTANCE → auto-discover via /instance/fetchInstances
// (e o resultado é persistido no DB pra próxima chamada).
let INSTANCE = process.env.EVOLUTION_INSTANCE || "";
let _cfgLoadedAt = 0;
let _autoDiscoverTried = false; // evita martelar fetchInstances por request
const CFG_TTL_MS = 15_000;

async function loadEvoCfg(force = false): Promise<void> {
  if (!force && _cfgLoadedAt && Date.now() - _cfgLoadedAt < CFG_TTL_MS) return;
  const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA_URL || !SUPA_SR) { _cfgLoadedAt = Date.now(); return; }
  try {
    const supa = createClient(SUPA_URL, SUPA_SR, { auth: { persistSession: false } });
    const { data } = await supa
      .from("app_settings")
      .select("key,value")
      .in("key", ["evolution_url", "evolution_api_key", "evolution_instance"]);
    const map: Record<string, string> = {};
    for (const r of (data ?? [])) {
      const v = (r?.value ?? "").trim();
      if (v) map[r.key] = v;
    }
    EVO_URL  = map.evolution_url      || process.env.EVOLUTION_API_URL  || "";
    EVO_KEY  = map.evolution_api_key  || process.env.EVOLUTION_API_KEY  || "";
    INSTANCE = map.evolution_instance || process.env.EVOLUTION_INSTANCE || "";
  } catch { /* mantém os valores atuais; melhor que crashar todas as rotas */ }
  _cfgLoadedAt = Date.now();
}

/** Invalida o cache para forçar releitura da próxima chamada (após troca de VPS pela UI). */
export function invalidateEvolutionCache(): void { _cfgLoadedAt = 0; _autoDiscoverTried = false; }

/**
 * Auto-descobre uma instância existente na Evolution se nenhuma estiver
 * configurada. Usa a 1ª retornada por /instance/fetchInstances e persiste no
 * DB pra próxima chamada não precisar redescobrir. Roda no máx 1 vez por
 * "ciclo" (até invalidateEvolutionCache).
 *
 * Por que isso existe: o user pediu pra remover qualquer chumbo de "sdr".
 * Sem auto-descoberta, qualquer rota disparada antes do user salvar uma
 * instância pela UI quebraria com "Sem instância configurada". Agora basta
 * a Evolution ter QUALQUER instância (não importa o nome) que o app pega
 * sozinho.
 */
async function autoDiscoverInstance(): Promise<string> {
  if (_autoDiscoverTried) return INSTANCE;
  _autoDiscoverTried = true;
  if (!EVO_URL || !EVO_KEY) return "";
  try {
    const base = EVO_URL.endsWith("/") ? EVO_URL.slice(0, -1) : EVO_URL;
    const res = await axios({
      url: `${base}/instance/fetchInstances`,
      method: "GET",
      headers: { apikey: EVO_KEY, "Content-Type": "application/json" },
      timeout: 10000,
      httpsAgent,
      transformResponse: [(d) => d],
    });
    let body: any = res.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return ""; } }
    const list = Array.isArray(body) ? body : (body?.instances || body?.data || []);
    if (!Array.isArray(list) || list.length === 0) return "";
    const first = list[0];
    const name = first?.instance?.instanceName || first?.instance?.name || first?.instanceName || first?.name;
    if (!name || typeof name !== "string") return "";
    INSTANCE = name;
    // Persiste no DB pra próxima chamada não precisar redescobrir.
    const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPA_SR  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (SUPA_URL && SUPA_SR) {
      try {
        const supa = createClient(SUPA_URL, SUPA_SR, { auth: { persistSession: false } });
        await supa.from("app_settings").upsert(
          { key: "evolution_instance", value: name, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
      } catch { /* ignore */ }
    }
    return name;
  } catch {
    return "";
  }
}

/**
 * Resolve a instância a usar quando o caller não especificou.
 * Carrega cfg do DB (se TTL expirou) e auto-descobre se ainda estiver vazia.
 * Lança erro claro se não conseguir resolver — assim o caller sabe que precisa
 * configurar Evolution antes de tentar enviar mensagem.
 */
export async function resolveInstance(provided?: string): Promise<string> {
  if (provided && provided.trim()) return provided.trim();
  await loadEvoCfg();
  if (INSTANCE) return INSTANCE;
  const discovered = await autoDiscoverInstance();
  if (discovered) return discovered;
  throw new Error(
    "Nenhuma instância Evolution configurada nem encontrada na API. " +
    "Crie uma instância em Configurações → Evolution API ou clique 'Conectar' na aba do Agente."
  );
}

/**
 * Lê as credenciais atuais. Por padrão dispara auto-descoberta da instância
 * se DB/env não tiverem valor — assim quem consome `cfg.instance` nunca
 * recebe string vazia (a menos que a Evolution não tenha NENHUMA instância,
 * caso em que vem "" silenciosamente — chamadas que dependem disso vão
 * falhar com erro claro pelo `resolveInstance()`).
 *
 * Use `{ resolve: false }` quando só quiser ler o estado bruto (ex: tela de
 * Configurações precisa mostrar "(vazio)" sem dispar fetchInstances).
 */
export async function getEvolutionConfig(
  forceOrOpts: boolean | { force?: boolean; resolve?: boolean } = false
): Promise<{ url: string; apiKey: string; instance: string; source: "db+env" | "env"; }> {
  const opts = typeof forceOrOpts === "boolean" ? { force: forceOrOpts, resolve: true } : { resolve: true, ...forceOrOpts };
  await loadEvoCfg(!!opts.force);
  if (opts.resolve && !INSTANCE) {
    await autoDiscoverInstance().catch(() => "");
  }
  return {
    url: EVO_URL,
    apiKey: EVO_KEY,
    instance: INSTANCE,
    source: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "db+env" : "env",
  };
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  family: 4
});

async function evoFetch(path: string, method: string = "GET", body?: unknown) {
  await loadEvoCfg();
  if (!EVO_URL || EVO_URL.includes("url_aqui")) {
    throw new Error("Evolution API URL não configurada. Configure em Configurações → Evolution API ou no .env.local.");
  }

  const url = `${EVO_URL.endsWith("/") ? EVO_URL.slice(0, -1) : EVO_URL}${path}`;

  try {
    const res = await axios({
      url,
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: EVO_KEY,
      },
      data: body,
      timeout: 30000, // Aumentado para 30s para instâncias pesadas
      httpsAgent,
      // Pede ao axios pra não lançar pelo content-type; queremos inspecionar a resposta bruta
      transformResponse: [(data) => data],
    });

    // Se o host respondeu com HTML (ex: página de erro do Easypanel, Cloudflare, Nginx),
    // o backend da Evolution está offline ou em crash. Joga um erro curto e acionável.
    const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const looksLikeHtml =
      (typeof raw === "string" && raw.trim().toLowerCase().startsWith("<!doctype")) ||
      (typeof raw === "string" && raw.trim().toLowerCase().startsWith("<html")) ||
      /content-type:\s*text\/html/i.test(res.headers?.["content-type"] || "");
    if (looksLikeHtml) {
      throw new Error("Evolution API offline: o host respondeu com uma página de erro (provavelmente o container parou no Easypanel). Reinicia o serviço.");
    }

    // Parse o JSON manualmente agora que já validamos
    try {
      return typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    } catch {
      // Resposta não é JSON nem HTML — retorna crua mesmo (raro, mas acontece em endpoints vazios)
      return res.data;
    }
  } catch (err: any) {
    if (err.code === 'ECONNABORTED') {
       throw new Error("Timeout: A Evolution API demorou muito para responder. Verifique sua conexão ou o servidor.");
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
       throw new Error(`Evolution API inacessível (${err.code}): confere se EVOLUTION_API_URL está correto e se o container está rodando.`);
    }
    const status = err.response?.status || "Network";
    // Se o erro já foi enriquecido acima (Evolution offline), propaga sem envelopar
    if (err.message?.startsWith("Evolution API offline")) throw err;

    const rawResp = err.response?.data;
    const errorDetail = typeof rawResp === 'object'
      ? JSON.stringify(rawResp)
      : (typeof rawResp === "string" && rawResp.trim().toLowerCase().startsWith("<!doctype"))
        ? "servidor respondeu HTML (provavelmente offline)"
        : (rawResp || err.message);

    console.error(`Evolution API Error [${method} ${path}]: ${String(errorDetail).slice(0, 200)}`);
    throw new Error(`Erro ${status}: ${String(errorDetail).slice(0, 300)}`);
  }
}

export const evolution = {
  /**
   * Snapshot SÍNCRONO da instância atual (pode estar vazio se ainda não foi
   * resolvida). Útil pra logs e UI; pra lógica que DEPENDE da instância,
   * use `await evolution.getActiveInstance()` que dispara auto-descoberta.
   */
  get instanceName() { return INSTANCE; },

  /** Versão async que garante resolução (DB → env → auto-discover). */
  async getActiveInstance(): Promise<string> {
    return resolveInstance();
  },

  async fetchInstances() {
     return evoFetch(`/instance/fetchInstances`);
  },

  async getStatus(instance?: string) {
    instance = await resolveInstance(instance);
    try {
      // EVOLUTION v2 BUG FIX:
      // O endpoint /instance/connectionState/:instanceName frequentemente fica preso
      // no status "connecting" ou "close" mesmo quando a instância está online e funcional.
      // A recomendação da comunidade é utilizar o /instance/fetchInstances que reflete
      // o status real (connectionStatus) e contém os dados completos do profile.
      const allData = await evoFetch(`/instance/fetchInstances?instanceName=${instance}`);
      const list = Array.isArray(allData) ? allData : (allData?.instances || []);
      
      const match = list.find((i: any) => {
        const name = i.instance?.instanceName || i.instance?.name || i.name || i.instanceName;
        return name === instance;
      });

      if (!match) {
        return { state: "not_found", data: null };
      }

      const state = match.instance?.connectionStatus || match.connectionStatus || "unknown";
      return {
        state,
        data: match,
      };
    } catch (err) {
      if ((err as Error).message.includes("404")) {
        return { state: "not_found", data: null };
      }
      throw err;
    }
  },

  async createInstance(instance: string) {
    // createInstance EXIGE nome explícito — não faz sentido auto-descobrir,
    // porque a intenção é criar algo novo. Quem chama (UI, ensure...) passa.
    if (!instance || !instance.trim()) {
      throw new Error("createInstance: nome da instância é obrigatório.");
    }
    // Evolution v2 espera camelCase. `reject_call` (snake) é silenciosamente
    // ignorado e a config fica `rejectCall:false` — daí ligações tocam mesmo
    // com a intenção contrária. Aplicamos settings inline no /instance/create
    // E em seguida via /settings/set como cinto-e-suspensório (algumas versões
    // só respeitam um dos caminhos).
    const created = await evoFetch("/instance/create", "POST", {
      instanceName: instance,
      token: EVO_KEY,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      rejectCall: true,
      msgCall: "No momento não atendemos por chamadas. Envie uma mensagem.",
      groupsIgnore: true,
      alwaysOnline: true,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    });
    try { await this.setSettings(instance); } catch { /* não fatal */ }
    return created;
  },

  /**
   * Aplica os settings padrão da instância no endpoint dedicado da v2.
   * Idempotente: pode rodar quantas vezes quiser.
   */
  async setSettings(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/settings/set/${instance}`, "POST", {
      rejectCall: true,
      msgCall: "No momento não atendemos por chamadas. Envie uma mensagem.",
      groupsIgnore: true,
      alwaysOnline: true,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    });
  },

  async findSettings(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/settings/find/${instance}`, "GET");
  },

  /**
   * Garante que a instância existe E está com settings + webhook corretos.
   * Chamada pelo "Conectar" da UI: se não existir cria; se existir, só
   * (re)aplica os settings e o webhook. Assim cada vez que o user clica
   * Conectar, a instância sai padronizada — não importa o estado prévio.
   * Retorna o resultado de /instance/connect (com QR/pairingCode).
   */
  async ensureInstanceConfigured(instance: string, publicAppUrl?: string) {
    const status = await this.getStatus(instance).catch(() => ({ state: "not_found" as const, data: null }));
    if (status.state === "not_found") {
      await this.createInstance(instance);
      // Pequena espera pra Evolution materializar a instância antes do connect.
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      // Já existe — só re-padroniza settings (não-fatal se falhar)
      try { await this.setSettings(instance); } catch { /* ignore */ }
    }
    if (publicAppUrl) {
      const baseUrl = publicAppUrl.endsWith("/") ? publicAppUrl.slice(0, -1) : publicAppUrl;
      try { await this.setWebhook(`${baseUrl}/api/webhooks/whatsapp`, instance); } catch { /* ignore */ }
    }
    return this.connect(instance);
  },
  
  async deleteInstance(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/instance/delete/${instance}`, "DELETE");
  },

  async connect(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/instance/connect/${instance}`);
  },

  async restartInstance(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/instance/restart/${instance}`, "PUT");
  },

  async logout(instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/instance/logout/${instance}`, "DELETE");
  },

  /**
   * Busca a foto de perfil de um número no WhatsApp.
   *
   * Endpoint Evolution API v2: POST /chat/fetchProfilePictureUrl/:instance
   * Body: { number: "5527999999999@s.whatsapp.net" }
   * Retorno: { wuid, profilePictureUrl } | { profilePictureUrl: null } se não tiver foto
   *
   * Evolution v2 às vezes responde 400 para números fora dos contatos da
   * instância — não é erro fatal, só significa "sem foto / sem visibilidade".
   * Retornamos null nesses casos.
   */
  async fetchProfilePicture(number: string, instance?: string): Promise<string | null> {
    instance = await resolveInstance(instance).catch(() => "");
    if (!instance) return null;
    if (!number.includes("@s.whatsapp.net") && !number.includes("@g.us")) {
      number = number.replace(/\D/g, "") + "@s.whatsapp.net";
    }
    try {
      const res = await evoFetch(`/chat/fetchProfilePictureUrl/${instance}`, "POST", { number });
      const url = res?.profilePictureUrl || res?.data?.profilePictureUrl || null;
      return typeof url === "string" && url.startsWith("http") ? url : null;
    } catch (err: any) {
      // 400/404 = sem foto/privacidade. Não loga como erro real.
      if (/40[04]|not found|no profile/i.test(err?.message || "")) return null;
      console.warn(`[Evolution] fetchProfilePicture(${number}):`, err?.message);
      return null;
    }
  },

  async sendTextMessage(number: string, text: string, instance?: string) {
    instance = await resolveInstance(instance);
    if (!number.includes("@s.whatsapp.net") && !number.includes("@g.us")) {
      number = number.replace(/\D/g, "") + "@s.whatsapp.net";
    }
    return evoFetch(`/message/sendText/${instance}`, "POST", { number, text });
  },

  async sendMessage(number: string, text: string, instance?: string) {
    if (!text) return null;
    instance = await resolveInstance(instance);

    // Na v2, o ideal é o número estar limpo ou ser o JID completo
    let target = number.replace(/\D/g, "");
    if (number.includes("@g.us")) {
       target = number; // mantém JID de grupo
    } else if (!target.includes("@")) {
       target = target + "@s.whatsapp.net";
    }

    // Simular digitação
    try {
      await this.sendPresence(target, "composing", instance);
    } catch {}

    return evoFetch(`/message/sendText/${instance}`, "POST", {
      number: target,
      text,
      linkPreview: true,
    });
  },

  async sendMedia(number: string, caption: string, mediaData: { type: "image" | "audio" | "document", base64: string, fileName?: string, mimetype?: string }, instance?: string) {
    instance = await resolveInstance(instance);
    const targetJid = (number.includes("@") && (number.endsWith(".net") || number.endsWith(".us")))
       ? number
       : number.replace(/\D/g, "") + "@s.whatsapp.net";

    // Simular digitação
    await this.sendPresence(targetJid, "composing", instance);

    if (mediaData.type === "audio") {
      return evoFetch(`/message/sendWhatsAppAudio/${instance}`, "POST", {
        number: targetJid,
        audio: mediaData.base64,
        delay: 2000
      });
    }

    return evoFetch(`/message/sendMedia/${instance}`, "POST", {
      number: targetJid,
      mediatype: mediaData.type,
      media: mediaData.base64,
      fileName: mediaData.fileName || "midia",
      caption: caption || "",
      delay: 1500
    });
  },

  async sendPresence(number: string, presence: "composing" | "recording" | "paused", instance?: string) {
    instance = await resolveInstance(instance).catch(() => "");
    if (!instance) return null;
    return evoFetch(`/chat/presence/${instance}`, "POST", {
      number,
      presence
    }).catch(() => null); // Ignora erros de presença para não travar o envio
  },

  // ================= PROXY =================
  // Evolution API v2: POST /proxy/set/{instance}  /  GET /proxy/find/{instance}
  // Proxies ajudam a evitar banimento: cada instância sai por um IP diferente.
  async setProxy(
    instance: string,
    proxy: {
      enabled: boolean;
      host?: string;
      port?: string | number;
      protocol?: "http" | "https" | "socks4" | "socks5";
      username?: string;
      password?: string;
    }
  ) {
    const body = {
      enabled: !!proxy.enabled,
      host: proxy.host || "",
      port: String(proxy.port || ""),
      protocol: proxy.protocol || "http",
      username: proxy.username || "",
      password: proxy.password || "",
    };
    return evoFetch(`/proxy/set/${instance}`, "POST", body);
  },

  async findProxy(instance: string) {
    return evoFetch(`/proxy/find/${instance}`, "GET");
  },

  async removeProxy(instance: string) {
    // enabled=false zera a config no backend da Evolution
    return evoFetch(`/proxy/set/${instance}`, "POST", {
      enabled: false,
      host: "",
      port: "",
      protocol: "http",
      username: "",
      password: "",
    });
  },

  async setWebhook(url: string, instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/webhook/set/${instance}`, "POST", {
      webhook: {
        url,
        enabled: true,
        webhookByEvents: false,
        base64: true,
        webhookBase64: true, // Compatibilidade v2
        events: [
          "MESSAGES_UPSERT",
          "MESSAGES_UPDATE",
          "MESSAGES_DELETE",
          "SEND_MESSAGE",
          "CONNECTION_UPDATE",
        ],
      }
    });
  },

  async findMessages(remoteJid: string, count: number = 20, instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/chat/findMessages/${instance}`, "POST", {
      where: {
        key: {
          remoteJid: remoteJid
        }
      },
      limit: count
    });
  },

  /**
   * Busca o base64 de uma mensagem de mídia pelo ID da mensagem.
   * Útil como fallback quando o webhook não traz o base64 inline.
   * Requer que a Evolution API tenha store habilitado.
   */
  async getBase64FromMedia(messageId: string, instance?: string) {
    instance = await resolveInstance(instance);
    return evoFetch(`/chat/getBase64FromMediaMessage/${instance}`, "POST", {
      message: { key: { id: messageId } },
      convertToMp4: false
    });
  },

  /** Extrai número limpo de um JID */
  extractPhone(jid: string): string {
    return jid?.replace("@s.whatsapp.net", "").replace("@g.us", "").replace(/\D/g, "") || "";
  },

  /**
   * Verifica se uma lista de números existe no WhatsApp.
   * Retorna objeto { [number]: exists:boolean }.
   * Usado no disparo pra pular números inválidos ANTES de gastar a tentativa de envio.
   */
  async checkWhatsAppNumbers(numbers: string[], instance?: string): Promise<Record<string, boolean>> {
    if (numbers.length === 0) return {};
    instance = await resolveInstance(instance).catch(() => "");
    if (!instance) return {};
    const clean = numbers.map(n => n.replace(/\D/g, "")).filter(Boolean);
    try {
      const res = await evoFetch(`/chat/whatsappNumbers/${instance}`, "POST", { numbers: clean });
      // Resposta Evolution v2: [{ jid, exists, number }]
      const map: Record<string, boolean> = {};
      const list = Array.isArray(res) ? res : (res?.numbers || []);
      for (const item of list) {
        const key = (item.number || item.jid || "").replace(/\D/g, "");
        if (key) map[key] = !!item.exists;
      }
      return map;
    } catch {
      // Se o endpoint falhar (instância offline etc), retorna vazio — deixa o envio tentar
      return {};
    }
  },
};
