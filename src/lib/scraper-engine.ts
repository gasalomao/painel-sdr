/**
 * scraper-engine — engine do scraper Google Maps + Puppeteer extraído
 * de /api/scraper pra permitir CHAMADA DIRETA pelo automation-worker
 * (sem HTTP self-call, que falha em alguns ambientes).
 *
 * Quem usa:
 *   - /api/scraper/route.ts  — wrappers HTTP pro /captador (browser)
 *   - lib/automation-worker  — chama startScraperRun() direto, in-process
 *
 * Estado é módulo-singleton — uma única instância de scraper por processo
 * Node, exatamente como antes.
 */

import { supabase, supabaseAdmin } from "@/lib/supabase";
import { getEvolutionConfig } from "@/lib/evolution";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";
import os from "os";
import fs from "fs";
import path from "path";

export interface Lead {
  name: string;
  phones: string;
  remoteJid: string;
  fullAddress: string;
  categories: string;
  averageRating: string;
  reviewCount: string;
  website: string;
  instagram: string;
  facebook: string;
  extractedAt: string;
  /** Reviews escritas (autor, nota, data, texto + fotoAutor + fotos anexadas
   *  + respostaDono + contador útil) — captura profunda do painel de detalhe
   *  do Maps. Vem como array de objetos já serializável. */
  reviewsDetalhes?: any[];
  /** Blob estruturado do painel "Sobre" do Maps. Inclui:
   *  - about (descrição curta)
   *  - descricao (descrição estendida)
   *  - services (lista de serviços)
   *  - subcategorias
   *  - pessoasProcuramPor ("As pessoas procuram por")
   *  - popularTimes (horários de pico da semana)
   *  - redesAdicionais (LinkedIn/Twitter/YouTube/TikTok/WhatsApp/Telegram)
   *  - menuUrl, reservaUrl
   *  - plusCode, lat, lng, placeId (espelhados p/ acesso fácil)
   *  - atualizadoEm
   */
  businessDetails?: any;
  openingHours?: any;
  attributes?: any[];
  priceRange?: string;
  openNow?: string;
  photos?: string[];
  mapsUrl?: string;
  /** Plus Code (Open Location Code) — referência única do lugar. */
  plusCode?: string;
  /** Latitude decimal (string p/ evitar perda de precisão). */
  lat?: string;
  /** Longitude decimal (string). */
  lng?: string;
  /** Place ID Google (ChIJ... ou 0x...:0x...). */
  placeId?: string;
  /** Distribuição de estrelas: { "5estrelas": 120, "4estrelas": 30, ... }. */
  distribuicaoEstrelas?: Record<string, number>;
  /** CEP extraído do endereço/painel. */
  cep?: string;

  // ============================================================
  // CAMPOS EXTRAS — captura ESTENDIDA (2026-07-22):
  // ============================================================

  /** Status operacional: "Operacional", "Permanently closed", "Temporarily closed". */
  businessStatus?: string;

  /** Se o dono reivindicou a ficha (Claimed). Negócios "Claimed" tendem a
   *  ser mais atenciosos/responsivos — sinal positivo pra B2B. */
  claimed?: boolean;

  /** Nome do proprietário/gerente quando exibido publicamente. */
  ownerName?: string;

  /** Ano de fundação do negócio (quando disponível). */
  yearEstablished?: string;

  /** Número TOTAL de fotos que o Google Maps tem do local (não só as 50 que
   *  capturamos em photos[] — isso é o count agregado). */
  totalPhotoCount?: number;

  /** Tópicos de reviews do Google: { "Comida": "4.8", "Atendimento": "4.5" }.
   *  Mostra os pontos fortes e fracos do negócio por categoria. */
  reviewTopics?: Record<string, string>;

  /** Reviews em destaque (Featured) — selecionadas pelo Google como mais úteis. */
  featuredReviews?: string[];

  /** Categorias secundárias (além da principal). */
  additionalCategories?: string[];

  /** Endereço separado em componentes: rua, número, bairro, cidade, estado, cep. */
  addressComponents?: {
    rua?: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
    cep?: string;
    pais?: string;
  } | null;
}

export interface ScraperSettings {
  webhookUrl?: string;
  webhookEnabled?: boolean;
  mode?: string;
  filterEmpty?: boolean;
  filterDuplicates?: boolean;
  filterLandlines?: boolean;
  filterWithWebsite?: boolean;
  captureAllReviews?: boolean;
  /** Limite máximo de leads a captar antes de parar. Quando atingido, o scraper
   *  sai do loop limpo, fecha o navegador, e o worker detecta o cap no próximo
   *  tick e avança pra fase de disparo. Sem limite = sem parada por contagem. */
  maxLeads?: number;
  client_id?: string | null;
  /** Resumo automático de avaliações com IA logo após salvar cada lead
   *  (fluxo Busca do /prospeccao-sites). Automação NÃO passa isto — ela roda
   *  o resumo em batch na fase de dispatch (automation-worker). */
  reviews_ai?: { enabled?: boolean; model?: string; prompt?: string | null };
}

// ---- Estado in-memory (singleton no processo Node) ----
let isScraping = false;
let isPaused = false;
let leadsStore: Lead[] = [];
let keepRunning = true;
let lastSearchNiche = "Leads";
let lastSearchRegion = "Exportados";
let currentAutomationId: string | null = null;
let currentClientId: string | null = null;

// SSE clients (apenas o /captador via browser inscreve)
const sseClients: Set<ReadableStreamDefaultController> = new Set();

export function attachSseClient(ctrl: ReadableStreamDefaultController) {
  sseClients.add(ctrl);
  // Envia estado atual imediato
  try {
    ctrl.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ event: "status", isScraping, isPaused, leadCount: leadsStore.length })}\n\n`
    ));
  } catch {}
}
export function detachSseClient(ctrl: ReadableStreamDefaultController) {
  sseClients.delete(ctrl);
}

function broadcast(data: Record<string, unknown>) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(new TextEncoder().encode(msg));
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

async function logToAutomation(message: string, level: "info" | "success" | "warning" | "error" = "info", kind: "scrape" | "state" | "error" = "scrape") {
  if (!currentAutomationId) return;
  try {
    const client = supabaseAdmin || supabase;
    if (!client) return;
    // .insert() do Supabase NÃO lança em erro de banco — devolve { error }.
    // Sem checar isso, uma falha de gravação (RLS, constraint) ficava
    // invisível e o log da automação parecia "incompleto" sem motivo.
    const { error } = await client.from("automation_logs").insert({
      automation_id: currentAutomationId,
      kind,
      level,
      message: String(message).slice(0, 1000),
      metadata: {},
    });
    if (error) console.warn("[SCRAPER] falha gravando automation_logs:", error.message);
  } catch (e) {
    console.warn("[SCRAPER] exceção gravando automation_logs:", (e as Error).message);
  }
}

function sendLog(message: string, type: string = "info") {
  const timestamp = new Date().toLocaleTimeString("pt-BR");
  broadcast({ event: "log", message, type, timestamp });
  console.log(`[SCRAPER] ${type.toUpperCase()}: ${message}`);
  if (currentAutomationId && !message.startsWith("[DEBUG]")) {
    const lvl: "info" | "success" | "warning" | "error" =
      type === "success" ? "success" :
      type === "warning" ? "warning" :
      type === "error" ? "error" : "info";
    logToAutomation(message, lvl).catch(() => {});
  }
}

function findChromeOnWindows(): string | null {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLandline(phone: string): boolean {
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("55") && clean.length === 12) return true;
  if (clean.length === 10) return true;
  if (clean.startsWith("0800") || clean.startsWith("3003") || clean.startsWith("4004")) return true;
  const local = clean.startsWith("55") ? clean.substring(4) : clean.substring(2);
  if (local.length === 8 && /^[2345]/.test(local)) return true;
  return false;
}

function formatJid(phone: string): string {
  let clean = phone.replace(/\D/g, "");
  if (!clean) return "";
  if (clean.length >= 10 && clean.length <= 11 && !clean.startsWith("55")) {
    clean = "55" + clean;
  }
  return `${clean}@s.whatsapp.net`;
}

export function formatLeadForN8n(lead: Lead) {
  // Caminho CHAVE-VALOR p/ integrações n8n/Zapier/Make (chaves snake_case,
  // fácil de mapear). Inclui TODOS os campos capturados do Maps — não perde
  // mais reviews, fotos, horários, popular times, redes sociais, etc.
  const bd: any = lead.businessDetails || {};
  return {
    // ---- Identificação básica ----
    nome_do_negocio: lead.name || "",
    telefone: lead.phones || "",
    endereco: lead.fullAddress || "",
    categoria_do_negocio: lead.categories || "",
    nicho_pesquisado: lastSearchNiche || "",
    regiao_pesquisada: lastSearchRegion || "",
    avaliacao: lead.averageRating || "",
    numero_avaliacoes: lead.reviewCount || "",
    website: lead.website || "",
    instagram: lead.instagram || "",
    facebook: lead.facebook || "",
    extraido_em: lead.extractedAt || "",
    remoteJid: lead.remoteJid || "",
    // ---- Localização precisa ----
    place_id: lead.placeId || "",
    plus_code: lead.plusCode || "",
    lat: lead.lat || "",
    lng: lead.lng || "",
    cep: lead.cep || "",
    maps_url: lead.mapsUrl || "",
    // ---- Funcionamento ----
    faixa_preco: lead.priceRange || "",
    aberto_agora: lead.openNow || "",
    horarios_funcionamento: lead.openingHours || null,
    // ---- Detalhes (sobre + serviços + subcategorias + redes) ----
    detalhes: lead.businessDetails || null,
    redes_adicionais: bd.redesAdicionais || null,
    menu_url: bd.menuUrl || "",
    reserva_url: bd.reservaUrl || "",
    descricao: bd.descricao || bd.about || "",
    servicos: bd.services || null,
    subcategorias: bd.subcategorias || null,
    pessoas_procuram_por: bd.pessoasProcuramPor || null,
    horarios_populares: bd.popularTimes || null,
    atualizado_em: bd.atualizadoEm || "",
    // ---- Atributos (delivery, acessibilidade, pagamentos, etc.) ----
    atributos: lead.attributes || null,
    // ---- Fotos ----
    fotos: lead.photos || null,
    // ---- Distribuição de estrelas (5★, 4★, 3★, 2★, 1★) ----
    distribuicao_estrelas: lead.distribuicaoEstrelas || null,
    // ---- Reviews completas (autor, nota, data, texto, fotos, respostaDono, util) ----
    reviews_detalhes: lead.reviewsDetalhes || null,
  };
}

/**
 * Checa se um remoteJid já está presente no CRM. "CRM" aqui inclui:
 *  - `leads_extraidos` (lead já capturado anteriormente, qualquer status)
 *  - `contacts`        (já existe conversa/contato real no WhatsApp)
 *
 * Se qualquer uma das duas tabelas tiver o JID, o lead é considerado DUPLICADO
 * e deve ser pulado por completo (não conta no maxLeads, não vai pra UI, não salva).
 *
 * Retorna `null` se NÃO está no CRM, ou string descritiva se está (pra log).
 */
export async function checkCrmDuplicate(remoteJid: string, clientId?: string | null): Promise<string | null> {
  if (!remoteJid) return null;
  try {
    const client = supabaseAdmin || supabase;
    if (!client) return null;
    
    let leadQ = client.from("leads_extraidos").select("id").eq("remoteJid", remoteJid);
    let contactQ = client.from("contacts").select("id").eq("remote_jid", remoteJid);
    
    if (clientId) {
      leadQ = leadQ.eq("client_id", clientId);
      contactQ = contactQ.eq("client_id", clientId);
    }
    
    const [leadRow, contactRow] = await Promise.all([
      leadQ.maybeSingle(),
      contactQ.maybeSingle(),
    ]);
    if (leadRow.data) return "leads_extraidos";
    if (contactRow.data) return "contacts";
    return null;
  } catch {
    return null; // em caso de erro, deixa passar — melhor extrair duplicado que perder lead
  }
}

async function saveLeadAndSync(lead: Lead, settings: ScraperSettings): Promise<number | null> {
  const hasWhatsApp = !!lead.remoteJid;

  try {
    const client = supabaseAdmin || supabase;
    if (!client) throw new Error("Supabase client não inicializado");

    // Se tem WhatsApp, checa duplicata
    if (hasWhatsApp) {
      const dupSource = await checkCrmDuplicate(lead.remoteJid, currentClientId);
      if (dupSource) {
        sendLog(`⏭️ "${lead.name}" já estava no CRM (${dupSource}) — pulando`, "info");
        return null;
      }
    }

    // Schema do leads_extraidos: avaliacao (NUMERIC), reviews (INT). Notas:
    //   - O nome correto da coluna é `avaliacao`, NÃO `rating` — bug histórico
    //     que rejeitava todos os INSERTs em bancos novos.
    //   - `instagram` e `facebook` foram adicionadas via migration (PARTE 3
    //     do SETUP_COMPLETO.sql); se o banco for muito antigo e não tiver
    //     elas, o fallback abaixo retira-as e tenta de novo.
    const fullPayload = {
      client_id: currentClientId || null,
      remoteJid: lead.remoteJid || null,
      nome_negocio: lead.name,
      telefone: lead.phones,
      ramo_negocio: lead.categories,
      endereco: lead.fullAddress,
      avaliacao: lead.averageRating ? Number(lead.averageRating) || null : null,
      reviews: lead.reviewCount ? Number(String(lead.reviewCount).replace(/\D/g, "")) || null : null,
      website: lead.website,
      instagram: lead.instagram,
      facebook: lead.facebook,
      // ---- Captura profunda do Maps (Migration 009) ----
      reviews_detalhes: lead.reviewsDetalhes || null,
      business_details: lead.businessDetails || null,
      opening_hours: lead.openingHours || null,
      attributes: lead.attributes || null,
      price_range: lead.priceRange || null,
      open_now: lead.openNow || null,
      photos: lead.photos || null,
      maps_url: lead.mapsUrl || null,
      // ---- Campos extras do painel de detalhe (Migration 011) ----
      place_id: lead.placeId || null,
      plus_code: lead.plusCode || null,
      lat: lead.lat ? Number(lead.lat) || null : null,
      lng: lead.lng ? Number(lead.lng) || null : null,
      cep: lead.cep || null,
      distribuicao_estrelas: lead.distribuicaoEstrelas || null,
      // ---- Campos extras da captura estendida (Migration 012) ----
      business_status: lead.businessStatus || null,
      claimed: lead.claimed ?? null,
      owner_name: lead.ownerName || null,
      year_established: lead.yearEstablished || null,
      total_photo_count: lead.totalPhotoCount ?? null,
      review_topics: lead.reviewTopics || null,
      featured_reviews: lead.featuredReviews || null,
      additional_categories: lead.additionalCategories || null,
      address_components: lead.addressComponents || null,
      instance_name: (await getEvolutionConfig()).instance,
      status: hasWhatsApp ? "novo" : "sem_contato",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    let savedId: number | null = null;

    let insertResult = await client.from("leads_extraidos").insert(fullPayload).select("id").single();
    let insError = insertResult.error as any;
    if (!insError) savedId = insertResult.data?.id ?? null;

    // PGRST204 = coluna inexistente. Banco antigo sem instagram/facebook/ou
    // sem as colunas JSONB da Migration 009/011/012 — tenta só com colunas garantidas.
    if (insError && insError.code === "PGRST204") {
      const minimal: any = { ...fullPayload };
      const maybeMissing = [
        "instagram", "facebook",
        "reviews_detalhes", "business_details", "opening_hours", "attributes",
        "price_range", "open_now", "photos", "maps_url",
        "place_id", "plus_code", "lat", "lng", "cep", "distribuicao_estrelas",
        // ---- Campos extras Migration 012 ----
        "business_status", "claimed", "owner_name", "year_established",
        "total_photo_count", "review_topics", "featured_reviews",
        "additional_categories", "address_components",
      ];
      for (const k of maybeMissing) delete minimal[k];
      const retry = await client.from("leads_extraidos").insert(minimal).select("id").single();
      insError = retry.error as any;
      if (!insError) savedId = retry.data?.id ?? null;
      if (!insError) {
        sendLog(`(banco antigo — lead salvo sem colunas extras do Maps/reviews)`, "warning");
      }
    }

    if (insError) throw insError;

    if (hasWhatsApp) {
      sendLog(`✅ Salvo: ${lead.name}`, "success");
    } else {
      sendLog(`✅ Salvo: ${lead.name} (sem WhatsApp — status: sem_contato)`, "success");
    }

    // Webhook realtime (best-effort): falha aqui não derruba o save.
    if (settings.webhookEnabled && settings.mode === "realtime" && settings.webhookUrl) {
      try {
        const payload = formatLeadForN8n(lead);
        await fetch(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendLog(`[Webhook] Lead enviado: ${lead.name}`, "success");
      } catch (err) {
        sendLog(`[Webhook] Falha ao enviar para n8n: ${(err as Error).message}`, "error");
      }
    }

    return savedId;
  } catch (err: any) {
    const msg = err?.message || String(err);
    const detail = err?.details || err?.hint || "";
    console.error("Erro ao salvar no Supabase (CRM):", msg, detail);
    sendLog(`❌ Falha ao salvar "${lead.name}": ${msg}${detail ? ` (${detail})` : ""}`, "error");
    return null;
  }
}

async function runScraper(niches: string[], regions: string[], settings: ScraperSettings) {
  if (isScraping) return;
  isScraping = true;
  isPaused = false;
  keepRunning = true;
  leadsStore = [];
  broadcast({ event: "status", isScraping: true, isPaused: false, leadCount: 0 });
  sendLog("Iniciando o Robô do lado do Servidor...", "info");

  // Captura o automation_id antes do finally pra poder atualizar o row
  // mesmo se algo der errado e currentAutomationId for resetado.
  const attachedAutomationId = currentAutomationId;
  let scraperError: string | null = null;
  let crmSkipped = 0; // contador de leads pulados por já estarem no CRM (escopo do finally)

  let browser;
  try {
    const puppeteerExtra = (await import("puppeteer-extra")).default;
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteerExtra.use(StealthPlugin());

    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) {
      if (os.platform() === "win32") {
        executablePath = findChromeOnWindows() || undefined;
        if (executablePath) sendLog(`Ambiente Windows detectado. Usando: ${executablePath}`, "info");
        else sendLog("Aviso: Navegador não encontrado no Windows. Tente instalar o Chrome.", "warning");
      } else {
        const linuxPaths = [
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
        ];
        for (const p of linuxPaths) {
          if (fs.existsSync(p)) {
            executablePath = p;
            break;
          }
        }
      }
    }

    const launchOptions: Record<string, unknown> = {
      headless: true,
      executablePath,
      ignoreDefaultArgs: ["--enable-automation"],
      env: {
        ...process.env,
        CHROME_CRASHPAD_PIPE_NAME: "",
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-first-run",
        "--no-zygote",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--crash-dumps-dir=/tmp",
        "--enable-crash-reporter-for-testing=0",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--password-store=basic",
        "--use-mock-keychain",
        "--window-size=1280,800",
      ],
    };

    browser = await puppeteerExtra.launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });

    const queue: string[] = [];
    for (const region of regions) {
      for (const niche of niches) {
        queue.push(`${niche.trim()} ${region.trim()}`);
      }
    }
    sendLog(`📋 Fila: ${queue.length} buscas${settings.maxLeads ? ` · limite ${settings.maxLeads} leads` : ""}`, "info");

    const maxLeads = Number(settings.maxLeads) || 0; // 0 = sem limite

    outer: for (let i = 0; i < queue.length; i++) {
      if (!keepRunning) {
        sendLog("Parada recebida. Abortando fila.", "warning");
        break;
      }
      // Já bateu o limite ANTES de começar a próxima busca? Para já.
      if (maxLeads > 0 && leadsStore.length >= maxLeads) {
        sendLog(`✓ Limite de ${maxLeads} leads atingido. Encerrando captação.`, "success");
        break;
      }
      while (isPaused && keepRunning) await sleep(1000);
      if (!keepRunning) break;

      const searchTerm = queue[i];
      sendLog(`(${i + 1}/${queue.length}) Buscando: "${searchTerm}"...`, "info");

      const encodedSearch = encodeURIComponent(searchTerm).replace(/%20/g, "+");
      await page.goto(`https://www.google.com/maps/search/${encodedSearch}?hl=pt-BR`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      sendLog("Mapa carregado. Aguardando resultados...", "info");

      // ---- Bypassing Google Consent / Cookie Page ----
      try {
        const hasConsent = await page.evaluate(() => {
          const isConsentUrl = window.location.href.includes("consent.google.com");
          if (isConsentUrl) return true;
          const text = document.body.innerText.toLowerCase();
          return text.includes("antes de continuar para o google") || 
                 text.includes("before you continue to google") || 
                 text.includes("antes de continuar para o youtube") ||
                 text.includes("antes de continuar");
        });

        if (hasConsent) {
          sendLog("Detectado aviso de privacidade/consentimento do Google. Aceitando...", "warning");
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const acceptButton = buttons.find(b => {
              const text = (b.textContent || b.innerText || "").toLowerCase();
              return text.includes('aceitar tudo') || 
                     text.includes('accept all') || 
                     text.includes('concordo') || 
                     text.includes('i agree') || 
                     text.includes('agree') ||
                     text.includes('aceitar') ||
                     text.includes('aceito');
            });
            if (acceptButton) {
              (acceptButton as HTMLButtonElement).click();
            } else {
              const form = document.querySelector('form[action*="consent.google.com/save"]');
              if (form) {
                (form as HTMLFormElement).submit();
              }
            }
          });
          // Wait for redirect/modal to dismiss and load Google Maps search results
          await sleep(5000);
        }
      } catch (e) {
        console.warn("[SCRAPER] Falha ao tentar aceitar consentimento do Google:", e);
      }
      // ------------------------------------------------

      try {
        await page.waitForSelector('[role="feed"]', { timeout: 15000 });
      } catch {
        sendLog(`Nenhuma lista para "${searchTerm}". Pulando.`, "warning");
        continue;
      }

      const extractedPlaces = new Set<string>();
      let scrolling = true;
      sendLog("Rolando para capturar cartões...", "info");

      while (scrolling && keepRunning) {
        await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (feed) feed.scrollBy(0, 1000);
        });
        await sleep(2000);

        const newLeads = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll(".Nv2PK"));
          return items.map((item) => {
            const nameEl = item.querySelector(".qBF1Pd");
            const urlEl = item.querySelector("a");
            return {
              name: nameEl ? nameEl.textContent?.trim() || "" : "",
              url: urlEl ? urlEl.getAttribute("href") || "" : "",
            };
          }).filter((l) => l.name && l.url);
        });

        for (const lead of newLeads) {
          if (!keepRunning) break;
          while (isPaused && keepRunning) await sleep(1000);
          if (!keepRunning) break;

          if (extractedPlaces.has(lead.name)) continue;
          extractedPlaces.add(lead.name);

          const cardData = await page.evaluate((leadName: string) => {
            const items = Array.from(document.querySelectorAll(".Nv2PK"));
            const item = items.find((el) => el.querySelector(".qBF1Pd")?.textContent?.trim() === leadName);
            if (!item) return null;
            const spans = Array.from(item.querySelectorAll(".W4Efsd > span")).map((s) => s.textContent?.trim() || "");
            const category = spans.find((s) => s.length > 2 && !s.includes("·") && !s.match(/\d/)) || "";
            const address = spans.find((s) => s.includes(",") || s.includes("Av.") || s.includes("Rua")) || spans[spans.length - 1] || "";
            const textC = item.textContent || "";

            // ---- Rating/reviews: multi-strategy (praticamente todos os cards
            // de Maps têm rating — regex antiga `(\d[.,]\d)\s*\(([\d.,k]+)\)`
            // perdia ~30% por exigir 1 casa decimal exata, colar parênteses
            // e não tolerar separador middot `·`. Agora tentamos:
            //   1) aria-label direto (role="img" com nota)
            //   2) regex expandida aceita `·`, 1-2 casas, k/K/m/M
            //   3) número isolado `4.8` seguido de parênteses solto
            //   4) fallback `X.Y estrelas` no textContent
            // Review count usa janela separada (não exige vínculo posicional
            // ao rating) — pega primeiro `(...)` ou `X avaliações`.
            // -----------------------------------------------------------
            let rating = "";
            let reviews = "";

            // (1) aria-label: "Avaliação 4.8 de 5", "4.8 stars", "Rated 4.8"
            const ariaEl = item.querySelector('[role="img"][aria-label], [aria-label*="estrela" i], [aria-label*="star" i], [aria-label*="avalia" i], [aria-label*="rated" i]') as HTMLElement | null;
            if (ariaEl) {
              const aria = ariaEl.getAttribute("aria-label") || "";
              const rm = aria.match(/(\d(?:[.,]\d{1,2})?)\s*(?:de\s*5\s*)?(?:estrela|star)/i)
                      || aria.match(/(?:avalia(?:ç|c)(?:ã|a)o|rated|rating|nota)\s*[:\s]*(\d(?:[.,]\d{1,2})?)/i);
              if (rm) rating = (rm[1] || rm[2] || "").replace(",", ".");
              const rcm = aria.match(/([\d.,]+[kKmM]?)\s*(?:avaliaç|review)/i);
              if (rcm) reviews = rcm[1];
            }

            // (2) regex expandida sobre textContent
            if (!rating) {
              const rMatch = textC.match(/(\d(?:[.,]\d{1,2})?)\s*(?:·|\s)*\(([\d.,]+[kKmM]?)\)/i);
              if (rMatch) { rating = rMatch[1].replace(",", "."); reviews = rMatch[2]; }
            }
            // (3) nota isolada seguida de parênteses em qualquer posição
            if (!rating) {
              const rMatch2 = textC.match(/(\d\.\d{1,2}|\d,\d{1,2})\s*[\(]?\s*(\d[\d.,]*[kKmM]?)\s*[\)]?/);
              if (rMatch2 && parseFloat(rMatch2[1].replace(",", ".")) <= 5) {
                rating = rMatch2[1].replace(",", ".");
                if (rMatch2[2] && /\d/.test(rMatch2[2])) reviews = rMatch2[2];
              }
            }
            // (4) fallback `4.8 estrelas` solto
            if (!rating) {
              const rMatch3 = textC.match(/(\d(?:[.,]\d{1,2})?)\s*(?:estrela|star)/i);
              if (rMatch3) rating = rMatch3[1].replace(",", ".");
            }
            // review count isolado: "1.234 avaliações" / "1.2k reviews"
            if (!reviews) {
              const rcMatch = textC.match(/([\d.,]+[kKmM]?)\s*(?:avaliaç|review)/i);
              if (rcMatch) reviews = rcMatch[1];
            }

            return {
              name: leadName,
              fullAddress: address,
              categories: category || "Comércio",
              averageRating: rating,
              reviewCount: reviews,
            };
          }, lead.name);

          if (!cardData) continue;

          let phoneStr = "";
          let websiteStr = "";
          let instagramStr = "";
          let facebookStr = "";
          let reviewsDetalhes: any[] = [];
          let businessDetails: any = null;
          let openingHours: any = null;
          let attributes: any[] = [];
          let priceRange = "";
          let openNow = "";
          let photos: string[] = [];
          let mapsUrl = "";
          let plusCode = "";
          let lat = "";
          let lng = "";
          let placeId = "";
          let distribuicaoEstrelas: Record<string, number> | undefined;
          let cep = "";
          // ---- Campos extras (2026-07-22) ----
          let businessStatus = "Operacional";
          let claimed = false;
          let ownerName = "";
          let yearEstablished = "";
          let totalPhotoCount: number | null = null;
          let reviewTopics: Record<string, string> | undefined;
          let featuredReviews: string[] | undefined;
          let additionalCategories: string[] | undefined;
          let addressComponents: any = null;
          let detailsPage;
          try {
            if (lead.url && browser) {
              detailsPage = await browser.newPage();
              await detailsPage.setRequestInterception(true);
              detailsPage.on("request", (req: { resourceType: () => string; abort: () => void; continue: () => void }) => {
                if (["image", "stylesheet", "font"].includes(req.resourceType())) req.abort();
                else req.continue();
              });
                await detailsPage.goto(lead.url, { waitUntil: "domcontentloaded", timeout: 15000 });
                await sleep(2000);
                // ---- Espera ativa pelo botão de telefone (lazy loading do Google Maps) ----
                // O Google Maps carrega o painel de detalhes mas o botão "Ligar"
                // pode demorar a aparecer. Tentamos até 5s esperando pelo elemento.
                try {
                 await detailsPage.waitForSelector(
                    '[data-item-id^="phone"], [data-tooltip*="telefone" i], [aria-label*="telefone" i], [aria-label*="phone" i], [aria-label*="Ligar" i], [aria-label*="Call" i]',
                    { timeout: 5000 }
                  );
                } catch {
                  // Se não achou nesse tempo, continua mesmo assim (fallbacks no evaluate resolverão).
                }

              // ============================================================
              // FASE 1 — Captura do PAINEL PRINCIPAL (antes de qualquer
              // clique em abas). Aqui estão phone, website, instagram,
              // facebook, priceRange, openNow, horários, atributos, fotos,
              // bloco "Sobre" e qualquer review já renderizada no card
              // inicial (Google mostra as 2-3 mais recentes no topo).
              // NÃO clica em nada — clique em "Avaliações" muda o painel
              // e esconde o botão de telefone, quebrando a captura.
              // ============================================================
              const mainExtracted = await detailsPage.evaluate(() => {
                let phone = "";
                let website = "";
                let instagram = "";
                let facebook = "";
                const redesAdicionais: Record<string, string> = {};

                // ---- Redes sociais e contatos (varredura de TODOS os links) ----
                const siteEls = Array.from(document.querySelectorAll('a[data-item-id="authority"], a[data-tooltip*="site" i], a[aria-label*="website" i], a[href^="http"]'));
                for (const a of siteEls) {
                  const v = (a as HTMLAnchorElement).href.toLowerCase();
                  if (v.includes("instagram.com")) { if (!instagram) instagram = (a as HTMLAnchorElement).href; }
                  else if (v.includes("facebook.com") || v.includes("fb.com")) { if (!facebook) facebook = (a as HTMLAnchorElement).href; }
                  else if (v.includes("linkedin.com")) { if (!redesAdicionais.linkedin) redesAdicionais.linkedin = (a as HTMLAnchorElement).href; }
                  else if (v.includes("twitter.com") || v.includes("x.com")) { if (!redesAdicionais.twitter) redesAdicionais.twitter = (a as HTMLAnchorElement).href; }
                  else if (v.includes("youtube.com") || v.includes("youtu.be")) { if (!redesAdicionais.youtube) redesAdicionais.youtube = (a as HTMLAnchorElement).href; }
                  else if (v.includes("tiktok.com")) { if (!redesAdicionais.tiktok) redesAdicionais.tiktok = (a as HTMLAnchorElement).href; }
                  else if (v.includes("wa.me") || v.includes("whatsapp.com")) { if (!redesAdicionais.whatsapp) redesAdicionais.whatsapp = (a as HTMLAnchorElement).href; }
                  else if (v.includes("t.me")) { if (!redesAdicionais.telegram) redesAdicionais.telegram = (a as HTMLAnchorElement).href; }
                  else if (v.includes("pinterest.com")) { if (!redesAdicionais.pinterest) redesAdicionais.pinterest = (a as HTMLAnchorElement).href; }
                  else if (!v.includes("google.com") && !v.includes("gstatic.com") && !website) {
                    if (!a.hasAttribute("jslog")) website = (a as HTMLAnchorElement).href;
                  }
                }

                const authorityEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement;
                if (authorityEl?.href && !authorityEl.href.includes("google.com")) website = authorityEl.href;

                // ---- Menu, Reservas, Agendamento ----
                let menuUrl = "";
                const menuEl = document.querySelector('a[data-item-id="menu"], a[aria-label*="menu" i], a[aria-label*="cardápio" i]') as HTMLAnchorElement;
                if (menuEl?.href) menuUrl = menuEl.href;
                let reservaUrl = "";
                const reservaEl = document.querySelector('a[data-item-id*="reserv"], a[aria-label*="reserva" i], a[aria-label*="Reserve" i], a[data-item-id="action_reservations"]') as HTMLAnchorElement;
                if (reservaEl?.href) reservaUrl = reservaEl.href;

                // ---- Telefone (vários seletores + fallback body text) ----
                // Regex brasileira expandida: aceita +55, DDD com/sem parênteses,
                // 9 inicial com/sem espaço, 4-5 dígitos + 4 dígitos, separadores -, . , espaço.
                // Ex: (27) 9 9876-5432 | (27) 99876-5432 | +55 27 3376-5432 | 2733765432 | 3376-5432
                const phoneRe = /(?:\+?55\s?)?(?:\(?0?\d{2}\)?[\s]?)?(?:9[\s]?)?(\d{4,5}[-\s.]?\d{4})/;

                const tooltipEls = Array.from(document.querySelectorAll(
                  '[data-item-id^="phone:tls"], [data-item-id^="phone"], ' +
                  'button[data-item-id^="phone"], a[data-item-id^="phone"], ' +
                  '[data-tooltip*="telefone" i], [aria-label*="telefone" i], ' +
                  '[data-tooltip*="phone" i], [aria-label*="phone" i], ' +
                  'button[aria-label*="Ligar" i], a[aria-label*="Ligar" i], ' +
                  'button[aria-label*="Call" i], a[aria-label*="Call" i]'
                ));
                for (const item of tooltipEls) {
                  const labelText = (item as HTMLElement).ariaLabel || item.getAttribute("data-tooltip") || item.getAttribute("data-item-id") || "";
                  const match = labelText.match(phoneRe);
                  if (match) { phone = labelText.trim(); break; }
                  const btnText = (item as HTMLElement).textContent || "";
                  const btnMatch = btnText.match(phoneRe);
                  if (btnMatch) { phone = btnText.trim(); break; }
                  // Se o aria-label é tipo "Ligar para +55 27 3376-5432", extrai só o número
                  const cleanNum = labelText.replace(/[^\d+]/g, "");
                  if (cleanNum.length >= 8) { phone = labelText; break; }
                }
                // Fallback 1: escanear botões que podem conter "Ligar" como texto
                if (!phone) {
                  const callButtons = Array.from(document.querySelectorAll('button, a'));
                  for (const btn of callButtons) {
                    const txt = (btn as HTMLElement).textContent || "";
                    if (/^(Ligar|Call)/i.test(txt.trim())) {
                      const aria = (btn as HTMLElement).getAttribute("aria-label") || txt;
                      const m = aria.match(phoneRe);
                      if (m) { phone = aria.trim(); break; }
                    }
                  }
                }
                // Fallback 2: varre o body inteiro com regex robusta
                if (!phone) {
                  const bodyText = document.body.innerText || "";
                  const bodyMatch = bodyText.match(phoneRe);
                  if (bodyMatch) phone = bodyMatch[0].trim();
                }
                // Fallback 3: procura por padrão "Telefone:" ou "Phone:" seguido de número
                if (!phone) {
                  const bodyText2 = document.body.innerText || "";
                  const labelMatch = bodyText2.match(/(?:Telefone|Phone|Tel\.?)\s*:?\s*(\+?\d[\d\s().-]{7,})/i);
                  if (labelMatch) phone = labelMatch[1].trim();
                }

                const canonicalHref = (document.querySelector('a[data-item-id="place_id"]') as HTMLAnchorElement)?.href
                  || (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href
                  || location.href;
                const mapsUrl = canonicalHref;

                // ---- Place ID (0x...:0x... ou ChIJ...) extraído da URL ----
                let placeId = "";
                const pidMatch1 = mapsUrl.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
                if (pidMatch1) placeId = pidMatch1[0];
                const pidMatch2 = mapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
                if (!placeId && pidMatch2) placeId = pidMatch2[1];
                const pidMatch3 = mapsUrl.match(/!2s(ChIJ[A-Za-z0-9_-]+)/);
                if (!placeId && pidMatch3) placeId = pidMatch3[1];
                const pidMatch4 = mapsUrl.match(/(ChIJ[A-Za-z0-9_-]+)/);
                if (!placeId && pidMatch4) placeId = pidMatch4[1];

                // ---- Latitude / Longitude extraídas da URL (!3dLAT!4dLNG) ----
                let lat = "";
                let lng = "";
                const latMatch = mapsUrl.match(/!3d(-?\d{1,3}\.\d+)/);
                const lngMatch = mapsUrl.match(/!4d(-?\d{1,3}\.\d+)/);
                if (latMatch) lat = latMatch[1];
                if (lngMatch) lng = lngMatch[1];
                // fallback na URL curta @lat,lng
                if (!lat) {
                  const atMatch = mapsUrl.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
                  if (atMatch) { lat = atMatch[1]; lng = atMatch[2]; }
                }

                // ---- Plus Code (Open Location Code) ----
                let plusCode = "";
                const plusEl = document.querySelector('[data-item-id="olr"], button[data-item-id*="olr"]') as HTMLElement;
                if (plusEl) {
                  plusCode = (plusEl.innerText || plusEl.getAttribute("aria-label") || "").trim();
                }
                if (!plusCode) {
                  const bodyTxt2 = document.body.innerText || "";
                  const pcMatch = bodyTxt2.match(/\b([23456789CFGHJMPQRVWX]{4}\+[23456789CFGHJMPQRVWX]{2,3}(?:,[23456789CFGHJMPQRVWX]+)?)\b/);
                  if (pcMatch) plusCode = pcMatch[1];
                }

                // ---- Faixa de preço + status "Aberto agora" ----
                let priceRange = "";
                const bodyTxt = document.body.innerText || "";
                const priceMatch = bodyTxt.match(/\${1,4}\s*·/) || bodyTxt.match(/\b(\${1,4})\b/);
                if (priceMatch) priceRange = priceMatch[1] || priceMatch[0].trim();
                let openNow = "";
                const openMatch = bodyTxt.match(/(Aberto agora|Fechado|Fechado temporariamente|Aberto 24 horas|Aberto .*?horas)/i);
                if (openMatch) openNow = openMatch[1];

                // ---- Horários de funcionamento detalhados por dia ----
                const openingHours: any = {};
                const hoursEls = Array.from(document.querySelectorAll('[aria-label*="horário" i], [aria-label*="hours" i], [data-tooltip*="horário" i]'));
                if (hoursEls.length > 0) {
                  const txt = (hoursEls[0] as HTMLElement).textContent || "";
                  const dayRe = /(Dom|Seg|Ter|Qua|Qui|Sex|S[aá]b|Sun|Mon|Tue|Wed|Thu|Fri|Sat)[\s:]+([0-9h:.\-–\s]+[0-9h:.\-–\s ]*)/gi;
                  let m: RegExpExecArray | null;
                  while ((m = dayRe.exec(txt))) openingHours[m[1]] = m[2].trim();
                  if (Object.keys(openingHours).length === 0) openingHours.raw = txt.slice(0, 500);
                }

                // ---- Popular times (horários de movimento da semana) ----
                const popularTimes: any = {};
                // Google renderiza como barras com aria-label "Movimentação: Segunda-feira, 14h, X%"
                const popEls = Array.from(document.querySelectorAll('div[aria-label*="movimentação" i], div[aria-label*="popular" i], bar[aria-label*="movimentação" i]'));
                for (const el of popEls) {
                  const aria = (el as HTMLElement).getAttribute("aria-label") || "";
                  const m = aria.match(/(Domingo|Segunda|Ter[cç]a|Quarta|Quinta|Sexta|S[aá]bado|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[^\d]*(\d{1,2})\s*h[^\d]*?(\d+)%/i);
                  if (m) {
                    const day = m[1];
                    if (!popularTimes[day]) popularTimes[day] = [];
                    popularTimes[day].push({ hora: parseInt(m[2]), ocupacao: parseInt(m[3]) });
                  }
                }
                // também tenta o bloco "Movimentação atual"
                const liveMatch = bodyTxt.match(/(?:Movimentação atual|Live){1}[:\s]*((?:Muito|Bastante|Pouco|Normal|Ocupad[oa]|Vazio|Tranquilo)[^\n.]{0,30})/i);
                if (liveMatch) popularTimes.atual = liveMatch[1].trim();

                // ---- Atributos (delivery, acessibilidade, etc.) — captura categoria + valor ----
                const attributes: any[] = [];
                const attrSeen = new Set<string>();
                const attrEls = Array.from(document.querySelectorAll('div[role="button"][aria-label], button[aria-label], div.D2Ei1b, button[jsaction*="pane"]'));
                for (const el of attrEls) {
                  const t = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                  const trimmed = t.trim();
                  if (!trimmed || trimmed.length > 80) continue;
                  if (/(delivery|entrega|retirada|takeout|dine-in|balcão|reserva|wheelchair|cadeira|estacionamento|parking|acessib|wifi|ar condicionado|pet friendly|aceita|cart[aã]o|dinheiro|pix|debit|credit|outdoor|ar livre|drive-thru)/i.test(trimmed)) {
                    if (!attrSeen.has(trimmed)) {
                      attrSeen.add(trimmed);
                      attributes.push(trimmed);
                    }
                  }
                  if (attributes.length >= 50) break;
                }

                // ---- Fotos (aumenta pra 50 e captura categorias) ----
                const photoSeen = new Set<string>();
                const photos: string[] = [];
                const imgEls = Array.from(document.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                for (const img of imgEls) {
                  const src = (img as HTMLImageElement).src.split("=")[0];
                  if (src && !photoSeen.has(src)) {
                    photoSeen.add(src);
                    photos.push(src);
                    if (photos.length >= 50) break;
                  }
                }

                // ---- Bloco "Sobre" + Serviços + Descrição completa ----
                const businessDetails: any = {};
                const aboutEl = document.querySelector('[aria-label*="sobre" i], [aria-label*="about" i], section[data-id="about"]');
                if (aboutEl) businessDetails.about = ((aboutEl as HTMLElement).innerText || "").slice(0, 5000);

                // Descrição estendida (alguns lugares têm "Descrição" separada do "Sobre")
                const descEl = document.querySelector('[aria-label*="descri" i], [jslog*="description"]');
                if (descEl) businessDetails.descricao = ((descEl as HTMLElement).innerText || "").slice(0, 3000);

                // Subcategorias / "As pessoas buscam por"
                const subcategorias: string[] = [];
                const subcatEls = Array.from(document.querySelectorAll('button[jslog*="attribute"], .gm2-body-text, .Rk53df'));
                for (const sc of subcatEls) {
                  const txt = (sc as HTMLElement).textContent?.trim() || "";
                  if (txt.length >= 3 && txt.length <= 80 && !subcategorias.includes(txt)) subcategorias.push(txt);
                  if (subcategorias.length >= 30) break;
                }
                if (subcategorias.length) businessDetails.subcategorias = subcategorias;

                // "As pessoas procuram por" / "People often search for"
                const pProcuram: string[] = [];
                const pProcuramMatch = bodyTxt.match(/(?:As pessoas procuram por|People (?:often )?search for)[:\s]*([^\n]{5,500})/i);
                if (pProcuramMatch) {
                  const itens = pProcuramMatch[1].split(/[,·|]/).map(s => s.trim()).filter(s => s.length >= 3 && s.length <= 80);
                  businessDetails.pessoasProcuramPor = itens.slice(0, 20);
                }

                // Serviços listados
                const serviceEls = Array.from(document.querySelectorAll('div[role="button"][aria-label*="serviço" i], li'));
                const services: string[] = [];
                for (const s of serviceEls) {
                  const t = (s as HTMLElement).textContent?.trim() || "";
                  if (t.length >= 3 && t.length <= 80 && !services.includes(t)) services.push(t);
                  if (services.length >= 30) break;
                }
                if (services.length) businessDetails.services = services;

                // "Atualizado há X" / Informações verificadas pelo dono
                const updatedMatch = bodyTxt.match(/(?:atualizado|updated)\s+(?:em|h[aá]|há)\s+([^\n.]{2,40})/i);
                if (updatedMatch) businessDetails.atualizadoEm = updatedMatch[1].trim();

                // ---- Anexar dados extras em businessDetails ----
                businessDetails.plusCode = plusCode;
                businessDetails.lat = lat;
                businessDetails.lng = lng;
                businessDetails.placeId = placeId;
                if (Object.keys(popularTimes).length > 0) businessDetails.popularTimes = popularTimes;
                if (Object.keys(redesAdicionais).length > 0) businessDetails.redesAdicionais = redesAdicionais;
                if (menuUrl) businessDetails.menuUrl = menuUrl;
                if (reservaUrl) businessDetails.reservaUrl = reservaUrl;

                // ---- CEP separado do endereço completo ----
                let cep = "";
                const cepMatch = bodyTxt.match(/\b(\d{5}-\d{3})\b/);
                if (cepMatch) cep = cepMatch[1];

                // ============================================================
                // CAPTURA EXTRA — campos avançados (2026-07-22):
                // - businessStatus: "Operacional" / "Permanently closed" / "Temporariamente fechado"
                // - claimed: se o dono reivindicou a ficha (sinal de negócio ativo/responsivo)
                // - ownerName: nome do dono/gerente quando listado publicamente
                // - yearEstablished: ano de fundação
                // - totalPhotoCount: nº TOTAL de fotos (mesmo que só pegamos 50)
                // - reviewTopics: tópicos do Google ("Comida: 4.8★", "Atendimento: 4.5★")
                // - featuredReviews: reviews em destaque escolhidas pelo Google
                // - additionalCategories: categorias secundárias
                // - addressComponents: rua/numero/bairro/cidade/estado separados
                // ============================================================
                let businessStatus = "Operacional";
                if (/permanently closed|fechado definitivamente|encerrado/i.test(bodyTxt)) {
                  businessStatus = "Permanently closed";
                } else if (/temporarily closed|fechado temporariamente/i.test(bodyTxt)) {
                  businessStatus = "Temporarily closed";
                }

                let claimed = false;
                const claimEl = document.querySelector('[aria-label*="reivindicad" i], [aria-label*="claim" i], [jslog*="claim"]');
                if (claimEl) claimed = true;
                // Fallback: o botão "Reivindicar esta empresa" aparece quando
                // NÃO é claimed. Se ele NÃO está, é porque JÁ é claimed.
                const claimThisBtn = document.querySelector('button[data-item-id*="claim"], button[aria-label*="Reivindicar" i]');
                if (!claimThisBtn) {
                  // Sem botão de reivindicar = já é gerenciado pelo dono.
                  // Confirmamos com mais um sinal: presence de "Gerenciar no Google"
                  // ou posts recentes / atualizações do dono.
                  const ownerManaged = document.querySelector('[jslog*="merchant"], [data-item-id*="owner"]');
                  if (ownerManaged) claimed = true;
                }

                let ownerName = "";
                const ownerNameEl = document.querySelector('[aria-label*="gerente" i], [aria-label*="manager" i], [jslog*="owner_name"]');
                if (ownerNameEl) {
                  const txt = (ownerNameEl as HTMLElement).innerText || "";
                  const m = txt.match(/(?:gerente|manager|propriet[aá]rio|owner)[:\s]*([^\n,]{2,60})/i);
                  if (m) ownerName = m[1].trim();
                }

                let yearEstablished = "";
                const yearMatch = bodyTxt.match(/(?:fundado|aberto|since|desde|established)\s+(?:em\s+|in\s+)?(\d{4})/i);
                if (yearMatch) yearEstablished = yearMatch[1];

                let totalPhotoCount: number | null = null;
                const photoCountMatch = bodyTxt.match(/(\d[\d.]*)\s+(?:fotos?|photos?)/i);
                if (photoCountMatch) {
                  totalPhotoCount = parseInt(photoCountMatch[1].replace(/\D/g, "")) || null;
                }

                // Tópicos das reviews: "Comida: 4.8", "Atendimento: 4.5", etc.
                // Google agrupa reviews em tópicos quando tem volume suficiente.
                const reviewTopics: Record<string, string> = {};
                const topicEls = Array.from(document.querySelectorAll('[jslog*="topic_rating"], [data-topic-rating], div[aria-label*=":" i]'));
                for (const tEl of topicEls) {
                  const aria = (tEl as HTMLElement).getAttribute("aria-label") || (tEl as HTMLElement).textContent || "";
                  const tm = aria.match(/([^:]{2,40}):\s*(\d(?:[.,]\d)?)/);
                  if (tm) {
                    const topic = tm[1].trim();
                    const rating = tm[2];
                    if (topic.length >= 3 && topic.length <= 40) reviewTopics[topic] = rating;
                  }
                  if (Object.keys(reviewTopics).length >= 10) break;
                }

                // Reviews em destaque (Featured) — selecionadas pelo Google
                const featuredReviews: any[] = [];
                const featuredEls = Array.from(document.querySelectorAll('[jslog*="featured"], div[data-featured="true"], div[aria-label*="destaque" i]'));
                for (const fEl of featuredEls) {
                  const txt = ((fEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                  if (txt.length > 30) featuredReviews.push(txt);
                  if (featuredReviews.length >= 3) break;
                }

                // Categorias secundárias (além da principal)
                const additionalCategories: string[] = [];
                const catEls = Array.from(document.querySelectorAll('button[jslog*="category"], button[aria-label*="categoria" i], a[href*="/search/"]'));
                for (const c of catEls) {
                  const txt = (c as HTMLElement).textContent?.trim() || "";
                  if (txt && txt.length >= 3 && txt.length <= 60 && !additionalCategories.includes(txt)) {
                    additionalCategories.push(txt);
                  }
                  if (additionalCategories.length >= 10) break;
                }

                // Address components (rua/numero/bairro/cidade/estado separados)
                const addressComponents: any = {};
                // Extrai endereço completo do painel de detalhes do Google Maps
                let fullAddress = "";
                const addrEl = document.querySelector('[data-item-id="address"], button[data-item-id="address"]') as HTMLElement;
                if (addrEl) fullAddress = (addrEl.innerText || addrEl.getAttribute("aria-label") || "").trim();
                if (!fullAddress) {
                  // Fallback: procura texto que parece endereço no body
                  const addrMatch = bodyTxt.match(/((?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rod\.?|Estrada)\s+[^,\n]+,\s*\d+)/i);
                  if (addrMatch) fullAddress = addrMatch[1].trim();
                }
                if (fullAddress) {
                  // Cidade/Estado: "São Paulo, SP" no final do endereço
                  const cityStateMatch = fullAddress.match(/([^,]+),\s*([A-Z]{2})\s*(?:[-,]|\s*$)/);
                  if (cityStateMatch) {
                    addressComponents.cidade = cityStateMatch[1].trim();
                    addressComponents.estado = cityStateMatch[2].trim();
                  }
                  // CEP
                  if (cep) addressComponents.cep = cep;
                  // Rua + número
                  const streetMatch = fullAddress.match(/^(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rod\.?)\s+([^,]+?),?\s*(\d+)?/i);
                  if (streetMatch) {
                    addressComponents.rua = streetMatch[0].trim();
                    if (streetMatch[2]) addressComponents.numero = streetMatch[2];
                  }
                  // Bairro: entre vírgulas (ex: "Rua X, 123, Bairro Y, Cidade - UF")
                  const parts = fullAddress.split(",").map((p: string) => p.trim());
                  if (parts.length >= 3) {
                    // 2º item costuma ser número, 3º bairro
                    if (!addressComponents.bairro && parts[2] && !/^\d/.test(parts[2])) {
                      addressComponents.bairro = parts[2].split(" - ")[0];
                    }
                  }
                }

                // ---- Avaliação agregada (estrelas + nº de reviews) ----
                // Google BR usa ária "Avaliação 4.8 de 5" (sem "estrela") e
                // `.F6sie`/`.MW4l2` nem sempre tem — multi-strategy igual ao
                // card. Praticamente todo negócio tem rating no painel detalhe.
                let ratingAggregate: string = "";
                let reviewCountAggregate: string = "";
                const rEl = document.querySelector(
                  '[role="img"][aria-label], [aria-label*="estrela" i], [aria-label*="star" i], [aria-label*="avalia" i], [aria-label*="rated" i], .F6sie, .MW4l2, .fontDisplayLarge'
                );
                if (rEl) {
                  const aria = (rEl as HTMLElement).getAttribute("aria-label") || "";
                  const m1 = aria.match(/(\d(?:[.,]\d{1,2})?)\s*(?:de\s*5\s*)?(?:estrela|star)/i)
                          || aria.match(/(?:avalia(?:ç|c)(?:ã|a)o|rated|rating|nota)\s*[:\s]*(\d(?:[.,]\d{1,2})?)/i);
                  if (m1) ratingAggregate = (m1[1] || m1[2] || "").replace(",", ".");
                  const m2 = aria.match(/(\d[\d.,]*[kKmM]?)\s*(?:avaliaç|review)/i);
                  if (m2) reviewCountAggregate = m2[1];
                }
                // textContent do próprio elemento rating (caso ária vazia)
                if (!ratingAggregate && rEl) {
                  const rt = (rEl as HTMLElement).textContent || "";
                  const tm = rt.match(/(\d(?:[.,]\d{1,2})?)/);
                  if (tm && parseFloat(tm[1].replace(",", ".")) <= 5) ratingAggregate = tm[1].replace(",", ".");
                }
                // bodyTxt: forma `4.8 (1.234)` / `4.8 · 1.234` / `4.8 estrelas`
                if (!ratingAggregate) {
                  const bMatch = bodyTxt.match(/(\d(?:[.,]\d{1,2})?)\s*(?:·|\s)*[\(]?\s*(\d[\d.,]*[kKmM]?)\s*[\)]?/)
                              || bodyTxt.match(/(\d(?:[.,]\d{1,2})?)\s*(?:estrela|star)/i);
                  if (bMatch) ratingAggregate = bMatch[1].replace(",", ".");
                }
                if (!reviewCountAggregate) {
                  const bMatch = bodyTxt.match(/([\d.,]+[kKmM]?)\s*(?:avaliaç|review)/i)
                              || bodyTxt.match(/[\(]\s*([\d.,]+[kKmM]?)\s*[\)]/);
                  if (bMatch) reviewCountAggregate = bMatch[1];
                }

                // ---- Distribuição de estrelas (5★, 4★, 3★, 2★, 1★) ----
                // Google mostra como barras com aria-label "5 estrelas: 123".
                const distribuicaoEstrelas: Record<string, number> = {};
                const distEls = Array.from(document.querySelectorAll('tr[aria-label*="estrela" i], div[aria-label*="estrela" i], bar[aria-label*="star" i]'));
                for (const el of distEls) {
                  const aria = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                  const dm = aria.match(/(\d)\s*(?:estrela|star)s?[^0-9]*(\d[\d.,]*)/i);
                  if (dm) {
                    const star = dm[1];
                    const count = parseInt(dm[2].replace(/\D/g, "")) || 0;
                    distribuicaoEstrelas[`${star}estrelas`] = count;
                  }
                }

                // ---- Reviews que já vêm renderizadas no painel principal ----
                // Google coloca as 2-3 mais recentes no topo.
                const reviewEls0 = Array.from(document.querySelectorAll('div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]'));
                const reviewsInitial: any[] = [];
                const reviewSeen = new Set<string>();
                for (const r of reviewEls0) {
                  const aria = r.getAttribute("aria-label") || "";
                  const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(?::|\s+\d\s)/i);
                  const author = authorMatch ? authorMatch[1].trim() : "";
                  const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                  const rating = ratingMatch ? ratingMatch[1] : "";
                  const text = ((r as HTMLElement).innerText || "").slice(0, 1500).trim();
                  const sig = text.slice(0, 80);
                  if (!text || reviewSeen.has(sig)) continue;
                  reviewSeen.add(sig);
                  const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                  // Foto do reviewer (avatar)
                  const authorImg = r.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement;
                  const fotoAutor = authorImg ? (authorImg.src.split("=")[0]) : "";
                  // Fotos anexadas à review (não contar o avatar)
                  const fotos: string[] = [];
                  const reviewImgs = Array.from(r.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                  for (const img of reviewImgs) {
                    const src = (img as HTMLImageElement).src.split("=")[0];
                    if (src && src !== fotoAutor && !fotos.includes(src) && fotos.length < 8) fotos.push(src);
                  }
                  // Resposta do dono (bloco separado dentro da review)
                  let respostaDono = "";
                  const ownerReplyEl = r.querySelector('[jslog*="owner"], div[data-owner-response], [class*="owner"]');
                  if (ownerReplyEl) respostaDono = ((ownerReplyEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                  // Contador "útil" / likes
                  let util = 0;
                  const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                  if (utilMatch) util = parseInt(utilMatch[1]);
                  reviewsInitial.push({
                    autor: author,
                    nota: rating,
                    data: dateMatch ? dateMatch[1] : "",
                    texto: text,
                    fotoAutor,
                    fotos: fotos.length ? fotos : undefined,
                    respostaDono: respostaDono || undefined,
                    util: util || undefined,
                  });
                  if (reviewsInitial.length >= 50) break;
                }

                return {
                  phone, website, instagram, facebook,
                  mapsUrl,
                  priceRange,
                  openNow,
                  openingHours,
                  attributes,
                  photos,
                  businessDetails,
                  reviews: reviewsInitial,
                  ratingAggregate,
                  reviewCountAggregate,
                  distribuicaoEstrelas: Object.keys(distribuicaoEstrelas).length > 0 ? distribuicaoEstrelas : undefined,
                  cep,
                  plusCode,
                  lat,
                  lng,
                  placeId,
                  // ---- Campos extras (2026-07-22) ----
                  businessStatus,
                  claimed,
                  ownerName,
                  yearEstablished,
                  totalPhotoCount,
                  reviewTopics: Object.keys(reviewTopics).length > 0 ? reviewTopics : undefined,
                  featuredReviews: featuredReviews.length > 0 ? featuredReviews : undefined,
                  additionalCategories: additionalCategories.length > 0 ? additionalCategories : undefined,
                  addressComponents: Object.keys(addressComponents).length > 0 ? addressComponents : undefined,
                };
              });

              if (mainExtracted) {
                phoneStr = mainExtracted.phone;
                websiteStr = mainExtracted.website;
                instagramStr = mainExtracted.instagram;
                facebookStr = mainExtracted.facebook;
                if (Array.isArray(mainExtracted.reviews) && mainExtracted.reviews.length > 0) reviewsDetalhes = mainExtracted.reviews;
                if (mainExtracted.businessDetails && Object.keys(mainExtracted.businessDetails).length > 0) businessDetails = mainExtracted.businessDetails;
                if (mainExtracted.openingHours && Object.keys(mainExtracted.openingHours).length > 0) openingHours = mainExtracted.openingHours;
                if (Array.isArray(mainExtracted.attributes) && mainExtracted.attributes.length > 0) attributes = mainExtracted.attributes;
                if (mainExtracted.priceRange) priceRange = mainExtracted.priceRange;
                if (mainExtracted.openNow) openNow = mainExtracted.openNow;
                if (Array.isArray(mainExtracted.photos) && mainExtracted.photos.length > 0) photos = mainExtracted.photos;
                if (mainExtracted.mapsUrl) mapsUrl = mainExtracted.mapsUrl;
                // fallback: se o scraper principal (cardData) não tiver pego
                // rating/reviews, usa o que veio do painel de detalhe.
                if (!cardData.averageRating && mainExtracted.ratingAggregate) cardData.averageRating = mainExtracted.ratingAggregate;
                if (!cardData.reviewCount && mainExtracted.reviewCountAggregate) cardData.reviewCount = mainExtracted.reviewCountAggregate;
                if (mainExtracted.plusCode) plusCode = mainExtracted.plusCode;
                if (mainExtracted.lat) lat = mainExtracted.lat;
                if (mainExtracted.lng) lng = mainExtracted.lng;
                if (mainExtracted.placeId) placeId = mainExtracted.placeId;
                if (mainExtracted.distribuicaoEstrelas) distribuicaoEstrelas = mainExtracted.distribuicaoEstrelas;
                if (mainExtracted.cep) cep = mainExtracted.cep;
                // ---- Campos extras (2026-07-22) ----
                if (mainExtracted.businessStatus) businessStatus = mainExtracted.businessStatus;
                if (mainExtracted.claimed) claimed = mainExtracted.claimed;
                if (mainExtracted.ownerName) ownerName = mainExtracted.ownerName;
                if (mainExtracted.yearEstablished) yearEstablished = mainExtracted.yearEstablished;
                if (mainExtracted.totalPhotoCount != null) totalPhotoCount = mainExtracted.totalPhotoCount;
                if (mainExtracted.reviewTopics) reviewTopics = mainExtracted.reviewTopics;
                if (mainExtracted.featuredReviews) featuredReviews = mainExtracted.featuredReviews;
                if (mainExtracted.additionalCategories) additionalCategories = mainExtracted.additionalCategories;
                if (mainExtracted.addressComponents) addressComponents = mainExtracted.addressComponents;
              }

              // ============================================================
              // FASE 2 — Capturar reviews profundas.
              // ============================================================
              const reviewLimit = settings.captureAllReviews ? Number.MAX_SAFE_INTEGER : 50;
              if (settings.captureAllReviews || reviewsDetalhes.length < reviewLimit) {
                try {
                  if (settings.captureAllReviews) sendLog(`📝 Carregando todas as avaliações disponíveis: ${cardData.name}`, "info");
                  const reviewsOpened = await detailsPage.evaluate(() => {
                    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
                    const trigger = candidates.find((element) => {
                      const text = `${element.getAttribute("aria-label") || ""} ${element.innerText || ""}`;
                      return /(?:avaliações|avaliacoes|reviews?)/i.test(text);
                    });
                    if (!trigger) return false;
                    trigger.click();
                    return true;
                  });
                  if (!reviewsOpened) {
                    const reviewsUrl = lead.url.endsWith("/reviews") ? lead.url : lead.url.replace(/\/?$/, "/reviews");
                    await detailsPage.goto(reviewsUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                  }
                  await detailsPage.waitForSelector('.jftiEf, div[data-review-id], div[role="article"]', { timeout: 8000 }).catch(() => {});
                  await sleep(1200);
                  await detailsPage.evaluate(() => { delete (window as any).__painelSdrReviews; });

                  // Distribuição de estrelas (barras 5★-1★) — melhor capturar
                  // aqui pq a página de reviews sempre mostra elas no topo.
                  if (!distribuicaoEstrelas) {
                    const dist = await detailsPage.evaluate(() => {
                      const out: Record<string, number> = {};
                      const distEls = Array.from(document.querySelectorAll('tr[aria-label*="estrela" i], div[aria-label*="estrela" i], bar[aria-label*="star" i], tr[jslog*="review"]'));
                      for (const el of distEls) {
                        const aria = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                        const dm = aria.match(/(\d)\s*(?:estrela|star)s?[^0-9]*(\d[\d.,]*)/i);
                        if (dm) out[`${dm[1]}estrelas`] = parseInt(dm[2].replace(/\D/g, "")) || 0;
                      }
                      return out;
                    });
                    if (Object.keys(dist).length > 0) distribuicaoEstrelas = dist;
                  }

                  let semNovidade = 0;
                  let cachedCountAnterior = 0;
                  const MAX_ROLAGENS = settings.captureAllReviews ? 1000 : 25;
                  for (let i = 0; i < MAX_ROLAGENS; i++) {
                    await detailsPage.evaluate(() => {
                      const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                      for (const review of Array.from(document.querySelectorAll(reviewSelector))) {
                        const expand = Array.from(review.querySelectorAll('button, [role="button"]')).find((element) => /^(?:mais|more)$/i.test((element.textContent || "").trim())) as HTMLElement | undefined;
                        expand?.click();
                      }
                    });
                    await sleep(250);
                    const novos = await detailsPage.evaluate(() => {
                      const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                      const cacheKey = "__painelSdrReviews";
                      const cached = ((window as any)[cacheKey] ||= {}) as Record<string, any>;
                      for (const review of Array.from(document.querySelectorAll(reviewSelector))) {
                        const element = review as HTMLElement;
                        const aria = element.getAttribute("aria-label") || "";
                        const text = element.innerText.trim().slice(0, 12000);
                        const signature = text.slice(0, 180);
                        if (!text || cached[signature]) continue;
                        const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(:|\s+\d\s)/i);
                        const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i) || text.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                        const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                        const authorImage = element.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement | null;
                        const fotoAutor = authorImage?.src.split("=")[0] || "";
                        const fotos = Array.from(element.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'))
                          .map((image) => (image as HTMLImageElement).src.split("=")[0])
                          .filter((src) => src && src !== fotoAutor)
                          .filter((src, index, list) => list.indexOf(src) === index)
                          .slice(0, 8);
                        const ownerReply = Array.from(element.querySelectorAll('[jslog*="owner"], div[data-owner-response], [class*="owner"]'))
                          .map((reply) => (reply as HTMLElement).innerText.trim())
                          .find((reply) => reply.length > 0) || "";
                        const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                        cached[signature] = {
                          autor: authorMatch ? authorMatch[1].trim() : "",
                          nota: ratingMatch ? ratingMatch[1] : "",
                          data: dateMatch ? dateMatch[1] : "",
                          texto: text,
                          fotoAutor: fotoAutor || undefined,
                          fotos: fotos.length ? fotos : undefined,
                          respostaDono: ownerReply || undefined,
                          util: utilMatch ? parseInt(utilMatch[1]) : undefined,
                        };
                      }
                      const firstReview = document.querySelector(reviewSelector) as HTMLElement | null;
                      const scroller = firstReview?.closest('[role="feed"], .m6QErb, [role="main"]') as HTMLElement | null;
                      const before = scroller?.scrollTop || 0;
                      if (scroller) scroller.scrollBy(0, Math.max(1200, scroller.clientHeight * 0.85));
                      return { before, cachedCount: Object.keys(cached).length };
                    });
                    await sleep(900);
                    const progresso = await detailsPage.evaluate((before: number) => {
                      const firstReview = document.querySelector('.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]') as HTMLElement | null;
                      const scroller = firstReview?.closest('[role="feed"], .m6QErb, [role="main"]') as HTMLElement | null;
                      return { moved: !!scroller && scroller.scrollTop > before, cachedCount: Object.keys((window as any).__painelSdrReviews || {}).length };
                    }, novos.before);
                    if (progresso.cachedCount === cachedCountAnterior) {
                      semNovidade++;
                      if (semNovidade >= 3) break;
                    } else {
                      semNovidade = 0;
                    }
                    cachedCountAnterior = progresso.cachedCount;
                  }
                  const reviewExtracted = await detailsPage.evaluate((limit: number) => {
                    const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                    const reviewEls = Array.from(document.querySelectorAll(reviewSelector));
                    const cached = (window as any).__painelSdrReviews || {};
                    const out: any[] = Object.values(cached);
                    const seen = new Set(out.map((review: any) => review.texto.slice(0, 80)));
                    for (const r of reviewEls) {
                      const aria = r.getAttribute("aria-label") || "";
                      const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(?::|\s+\d\s)/i);
                      const author = authorMatch ? authorMatch[1].trim() : "";
                      const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                      const rating = ratingMatch ? ratingMatch[1] : "";
                      const text = ((r as HTMLElement).innerText || "").slice(0, 12000).trim();
                      const sig = text.slice(0, 80);
                      if (!text || seen.has(sig)) continue;
                      seen.add(sig);
                      const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                      // Foto do reviewer (avatar)
                      const authorImg = r.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement;
                      const fotoAutor = authorImg ? (authorImg.src.split("=")[0]) : "";
                      // Fotos anexadas à review (não contar o avatar)
                      const fotos: string[] = [];
                      const reviewImgs = Array.from(r.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                      for (const img of reviewImgs) {
                        const src = (img as HTMLImageElement).src.split("=")[0];
                        if (src && src !== fotoAutor && !fotos.includes(src) && fotos.length < 8) fotos.push(src);
                      }
                      // Resposta do dono
                      let respostaDono = "";
                      const ownerReplyEl = r.querySelector('[jslog*="owner"], div[data-owner-response], [class*="owner"]');
                      if (ownerReplyEl) respostaDono = ((ownerReplyEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                      // Contador "útil"
                      let util = 0;
                      const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                      if (utilMatch) util = parseInt(utilMatch[1]);
                      out.push({
                        autor: author,
                        nota: rating,
                        data: dateMatch ? dateMatch[1] : "",
                        texto: text,
                        fotoAutor: fotoAutor || undefined,
                        fotos: fotos.length ? fotos : undefined,
                        respostaDono: respostaDono || undefined,
                        util: util || undefined,
                      });
                      if (out.length >= limit) break;
                    }
                    return out;
                  }, reviewLimit);
                  if (Array.isArray(reviewExtracted) && reviewExtracted.length > 0) {
                    // merge (dedupe por sig 80 chars)
                    const merged = new Map<string, any>();
                    for (const rv of [...reviewsDetalhes, ...reviewExtracted]) {
                      const sig = (rv.texto || rv.text || "").slice(0, 80);
                      merged.set(sig, rv);
                    }
                    reviewsDetalhes = Array.from(merged.values()).slice(0, reviewLimit);
                    if (settings.captureAllReviews) sendLog(`📝 ${reviewsDetalhes.length} avaliações capturadas: ${cardData.name}`, "success");
                  }
                } catch {
                  // se falhar navegação pra /reviews, mantém as reviews já
                  // capturadas na FASE 1 — não perdemos informação.
                }
              }
            }
          } catch {
            // detail page nav error, skip
          } finally {
            if (detailsPage) await detailsPage.close().catch(() => {});
          }

          const cleanPhone = phoneStr.replace(/\D/g, "");
          let pass = true;
          let reason = "";
          if (settings.filterEmpty && cleanPhone === "") { pass = false; reason = "Sem telefone"; }
          if (pass && settings.filterDuplicates && cleanPhone !== "") {
            if (leadsStore.find((l) => l.phones.replace(/\D/g, "") === cleanPhone)) { pass = false; reason = "Telefone duplicado"; }
          }
          if (pass && settings.filterLandlines && cleanPhone !== "" && isLandline(cleanPhone)) { pass = false; reason = "Telefone fixo"; }
          if (pass && settings.filterWithWebsite && websiteStr) { pass = false; reason = "Com site"; }

          if (pass) {
            const jid = formatJid(phoneStr);
            // Filtro CRM: se o JID já está no leads_extraidos OU contacts, pula
            // SEM contar pro maxLeads, sem broadcast, sem salvar duplicata.
            const dupSource = jid ? await checkCrmDuplicate(jid, currentClientId) : null;
            if (dupSource) {
              crmSkipped++;
              sendLog(`⏭️ Já no CRM (${dupSource}): ${cardData.name}`, "info");
            } else {
              // ---- Fallback final de rating: se nem card nem painel detalhe
              // devolveram nota (raro, mas acontece em variantes de DOM),
              // deriva média ponderada da distribuicaoEstrelas ou média
              // simples das notas individuais em reviewsDetalhes.
              // Praticamente todo negócio no Maps tem ao menos uma nota
              // alcançável por algum desses caminhos.
              // -----------------------------------------------------------
              if (!cardData.averageRating) {
                if (distribuicaoEstrelas && Object.keys(distribuicaoEstrelas).length > 0) {
                  let total = 0, sum = 0;
                  for (const [k, v] of Object.entries(distribuicaoEstrelas)) {
                    const star = parseInt(k) || 0;
                    if (star > 0 && v > 0) { total += v; sum += star * v; }
                  }
                  if (total > 0) cardData.averageRating = (sum / total).toFixed(1);
                } else if (reviewsDetalhes.length > 0) {
                  const rates = reviewsDetalhes
                    .map((r: any) => parseFloat(String(r?.rating || "").replace(",", ".")))
                    .filter((n: number) => !isNaN(n) && n > 0);
                  if (rates.length > 0) cardData.averageRating = (rates.reduce((a: number, b: number) => a + b, 0) / rates.length).toFixed(1);
                }
              }
              if (!cardData.reviewCount && reviewsDetalhes.length > 0) {
                cardData.reviewCount = String(reviewsDetalhes.length);
              }
              const finalLead: Lead = {
                name: cardData.name,
                fullAddress: cardData.fullAddress,
                categories: cardData.categories,
                phones: phoneStr,
                averageRating: cardData.averageRating,
                reviewCount: cardData.reviewCount,
                website: websiteStr,
                instagram: instagramStr,
                facebook: facebookStr,
                remoteJid: jid,
                extractedAt: new Date().toLocaleString("pt-BR"),
                reviewsDetalhes: reviewsDetalhes.length > 0 ? reviewsDetalhes : undefined,
                businessDetails: businessDetails || undefined,
                openingHours: openingHours || undefined,
                attributes: attributes.length > 0 ? attributes : undefined,
                priceRange: priceRange || undefined,
                openNow: openNow || undefined,
                photos: photos.length > 0 ? photos : undefined,
                mapsUrl: mapsUrl || undefined,
                plusCode: plusCode || undefined,
                lat: lat || undefined,
                lng: lng || undefined,
                placeId: placeId || undefined,
                distribuicaoEstrelas: distribuicaoEstrelas,
                cep: cep || undefined,
                // ---- Campos extras (2026-07-22) — captura estendida ----
                businessStatus: businessStatus || undefined,
                claimed: claimed || undefined,
                ownerName: ownerName || undefined,
                yearEstablished: yearEstablished || undefined,
                totalPhotoCount: totalPhotoCount ?? undefined,
                reviewTopics,
                featuredReviews,
                additionalCategories,
                addressComponents,
              };
              leadsStore.push(finalLead);
              broadcast({ event: "new_lead", lead: finalLead, count: leadsStore.length });
              const savedLeadId = await saveLeadAndSync(finalLead, settings);

              // Resumo automático de avaliações com IA — roda NA HORA em cada
              // lead salvo (fluxo Busca com "Resumir avaliações com IA" ligado).
              // Best-effort: falha não interrompe a captura.
              if (savedLeadId && settings.reviews_ai?.enabled && settings.reviews_ai.model) {
                sendLog(`🧠 Resumindo avaliações de "${finalLead.name}" com IA (${settings.reviews_ai.model})...`, "info");
                try {
                  const r = await summarizeReviewsForLead({
                    leadId: savedLeadId,
                    model: settings.reviews_ai.model,
                    customPrompt: settings.reviews_ai.prompt || null,
                    clientId: currentClientId,
                    source: "capture",
                  });
                  if ("error" in r) {
                    sendLog(`⚠️ Reviews-IA "${finalLead.name}": ${r.error}`, "warning");
                  } else {
                    sendLog(`🧠 Resumo de avaliações ${r.cached ? "(cache) " : ""}salvo: ${finalLead.name}`, "success");
                  }
                } catch (e: any) {
                  sendLog(`⚠️ Reviews-IA falhou (${finalLead.name}): ${e?.message || e}`, "warning");
                }
              }

              // Bateu o limite? Para tudo agora — sai do scroll, sai da fila.
              if (maxLeads > 0 && leadsStore.length >= maxLeads) {
                sendLog(`🎯 Limite de ${maxLeads} leads atingido. Encerrando.`, "success");
                scrolling = false;
                break outer;
              }
            }
          } else {
            sendLog(`🚫 Descartado (${reason}): ${lead.name}`, "warning");
          }
        }

        const isEnd = await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (!feed) return true;
          return feed.textContent?.includes("Você chegou ao final") || feed.textContent?.includes("final da lista") || false;
        });
        if (isEnd) {
          scrolling = false;
          sendLog(`Fim dos resultados para "${searchTerm}". Total: ${extractedPlaces.size}`, "info");
        }
      }
    }

    sendLog(`🎉 Fila processada! Total: ${leadsStore.length} leads`, "success");

    if (settings.webhookEnabled && settings.mode === "batch" && settings.webhookUrl && leadsStore.length > 0) {
      sendLog("Enviando em massa para n8n...", "info");
      try {
        const payload = leadsStore.map(formatLeadForN8n);
        await fetch(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendLog(`[Webhook] ${payload.length} leads enviados em massa!`, "success");
      } catch (err) {
        sendLog(`[Webhook] Falha no envio em massa: ${(err as Error).message}`, "error");
      }
    }
  } catch (err) {
    scraperError = (err as Error).message || String(err);
    sendLog(`❌ Erro no scraper: ${scraperError}`, "error");
  } finally {
    if (browser) await browser.close().catch(() => {});
    isScraping = false;
    isPaused = false;
    broadcast({ event: "status", isScraping: false, isPaused: false, leadCount: leadsStore.length });
    sendLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");
    sendLog(`🏁 Captação concluída`, "success");
    sendLog(`   ✅ ${leadsStore.length} lead(s) novo(s) salvo(s)`, "success");
    if (crmSkipped > 0) sendLog(`   ⏭️ ${crmSkipped} lead(s) pulado(s) (já no CRM)`, "info");
    sendLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");

    // Se o scraper estava atrelado a uma automação E falhou OU não captou
    // nada, marca o row em erro imediatamente — em vez de esperar o tick
    // global descobrir 5min depois. Usuário vê a causa real direto no card.
    if (attachedAutomationId) {
      const client = supabaseAdmin || supabase;
      try {
        if (scraperError) {
          await client.from("automations").update({
            phase: "error",
            status: "error",
            last_error: `Scraper falhou: ${scraperError}`.slice(0, 500),
            last_error_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", attachedAutomationId);
        } else if (leadsStore.length === 0) {
          // Scraper rodou OK mas Google Maps não retornou nada pros termos
          // pesquisados. Marca erro pra usuário ajustar nicho/região.
          await client.from("automations").update({
            phase: "error",
            status: "error",
            last_error: "Scraper terminou sem captar nenhum lead. Verifica se nicho + região retornam resultados no Google Maps manualmente.",
            last_error_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", attachedAutomationId);
        } else {
          // SUCESSO com leads. Sinaliza a conclusão DEFINITIVA do scrape
          // (`_scrapeFinishedAt`) — assim o automation-worker avança pro
          // disparo na hora, sem depender da heurística de 120s ocioso.
          try {
            const { data: row } = await client
              .from("automations")
              .select("scrape_filters")
              .eq("id", attachedAutomationId)
              .maybeSingle();
            const filters = {
              ...((row?.scrape_filters as Record<string, any>) || {}),
              _scrapeFinishedAt: new Date().toISOString(),
            };
            await client.from("automations").update({
              scrape_filters: filters,
              updated_at: new Date().toISOString(),
            }).eq("id", attachedAutomationId);
          } catch (e) {
            console.warn("[SCRAPER-ENGINE] falha marcando _scrapeFinishedAt:", (e as Error).message);
          }
          // Cutuca o worker pra avançar JÁ — não espera o ticker de 60s.
          // import() dinâmico evita ciclo estático scraper-engine ↔ worker.
          try {
            const { tickAllAutomations } = await import("@/lib/automation-worker");
            await tickAllAutomations();
          } catch (e) {
            console.warn("[SCRAPER-ENGINE] tick pós-scrape falhou:", (e as Error).message);
          }
        }
      } catch (e) {
        console.warn("[SCRAPER-ENGINE] falha atualizando automação após scrape:", (e as Error).message);
      }
    }
    currentAutomationId = null;
  }
}

// ===========================================================================
// PUBLIC API — chamada por route.ts (HTTP) e automation-worker (in-process)
// ===========================================================================

export interface StartOpts {
  niches: string[];
  regions: string[];
  webhookUrl?: string;
  webhookEnabled?: boolean;
  mode?: string;
  filterEmpty?: boolean;
  filterDuplicates?: boolean;
  filterLandlines?: boolean;
  filterWithWebsite?: boolean;
  captureAllReviews?: boolean;
  /** Limite de leads — quando atingido o scraper sai limpo. */
  maxLeads?: number;
  automation_id?: string | null;
  client_id?: string | null;
  reviews_ai?: { enabled?: boolean; model?: string; prompt?: string | null };
  /** Se true, reseta qualquer captura travada anterior e força o início limpo. */
  forceRestart?: boolean;
}

/**
 * Inicia o scraper. Retorna { ok: true } imediato; o scraping roda em
 * background. Se já estiver rodando, retorna { ok: true, alreadyRunning: true }
 * e atrela o automation_id (se passado) ao run em andamento.
 */
export function startScraperRun(opts: StartOpts): { ok: boolean; error?: string; alreadyRunning?: boolean } {
  if (!opts.niches?.length || !opts.regions?.length) {
    return { ok: false, error: "Forneça pelo menos 1 nicho e 1 região." };
  }
  if (isScraping && opts.forceRestart) {
    stopScraper();
  } else if (isScraping) {
    if (opts.automation_id) currentAutomationId = opts.automation_id;
    return { ok: true, alreadyRunning: true };
  }
  isScraping = false;
  lastSearchNiche = opts.niches[0];
  lastSearchRegion = opts.regions[0];
  currentAutomationId = opts.automation_id || null;
  currentClientId = opts.client_id || null;
  // Fire-and-forget — runScraper tem try/finally que reseta isScraping=false.
  runScraper(opts.niches, opts.regions, {
    webhookUrl: opts.webhookUrl,
    webhookEnabled: opts.webhookEnabled,
    mode: opts.mode,
    filterEmpty: opts.filterEmpty,
    filterDuplicates: opts.filterDuplicates,
    filterLandlines: opts.filterLandlines,
    filterWithWebsite: opts.filterWithWebsite,
    captureAllReviews: opts.captureAllReviews,
    maxLeads: opts.maxLeads,
    reviews_ai: opts.reviews_ai,
  });
  return { ok: true };
}

export function stopScraper() {
  keepRunning = false;
  isScraping = false;
  isPaused = false;
  sendLog("Parando robô...", "warning");
}
export function pauseScraper() {
  isPaused = true;
  sendLog("Extração pausada.", "warning");
  broadcast({ event: "status", isScraping: true, isPaused: true, leadCount: leadsStore.length });
}
export function resumeScraper() {
  isPaused = false;
  sendLog("Extração retomada.", "info");
  broadcast({ event: "status", isScraping: true, isPaused: false, leadCount: leadsStore.length });
}
export function clearLeads() {
  leadsStore = [];
  broadcast({ event: "leads_update", leads: [], count: 0 });
}
export function getLeads() {
  return { leads: leadsStore, count: leadsStore.length };
}
export function getStatus() {
  return { isScraping, isPaused, leadCount: leadsStore.length };
}
export async function sendLeadsBatch(webhookUrl: string) {
  if (!webhookUrl || leadsStore.length === 0) return { ok: false, error: "Sem leads ou URL" };
  try {
    const payload = leadsStore.map(formatLeadForN8n);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      sendLog(`[Webhook] Lista com ${payload.length} leads enviada!`, "success");
      return { ok: true, count: payload.length };
    } else {
      sendLog(`[Webhook] Erro: ${res.status}`, "error");
      return { ok: false, error: `Erro: ${res.status}` };
    }
  } catch (err) {
    sendLog(`[Webhook] Falha: ${(err as Error).message}`, "error");
    return { ok: false, error: (err as Error).message };
  }
}
