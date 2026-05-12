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
}

export interface ScraperSettings {
  webhookUrl?: string;
  webhookEnabled?: boolean;
  mode?: string;
  filterEmpty?: boolean;
  filterDuplicates?: boolean;
  filterLandlines?: boolean;
  /** Limite máximo de leads a captar antes de parar. Quando atingido, o scraper
   *  sai do loop limpo, fecha o navegador, e o worker detecta o cap no próximo
   *  tick e avança pra fase de disparo. Sem limite = sem parada por contagem. */
  maxLeads?: number;
}

// ---- Estado in-memory (singleton no processo Node) ----
let isScraping = false;
let isPaused = false;
let leadsStore: Lead[] = [];
let keepRunning = true;
let lastSearchNiche = "Leads";
let lastSearchRegion = "Exportados";
let currentAutomationId: string | null = null;

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
    await client.from("automation_logs").insert({
      automation_id: currentAutomationId,
      kind,
      level,
      message: String(message).slice(0, 1000),
      metadata: {},
    });
  } catch {}
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
  return {
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
export async function checkCrmDuplicate(remoteJid: string): Promise<string | null> {
  if (!remoteJid) return null;
  try {
    const client = supabaseAdmin || supabase;
    if (!client) return null;
    // Em paralelo — dedupe deve ser O(1) extra de latência.
    const [leadRow, contactRow] = await Promise.all([
      client.from("leads_extraidos").select("id").eq("remoteJid", remoteJid).maybeSingle(),
      client.from("contacts").select("id").eq("remote_jid", remoteJid).maybeSingle(),
    ]);
    if (leadRow.data) return "leads_extraidos";
    if (contactRow.data) return "contacts";
    return null;
  } catch {
    return null; // em caso de erro, deixa passar — melhor extrair duplicado que perder lead
  }
}

async function saveLeadAndSync(lead: Lead, settings: ScraperSettings) {
  if (!lead.remoteJid) {
    sendLog(`⚠️ Pulando "${lead.name}" — sem WhatsApp válido`, "warning");
  } else {
    try {
      const client = supabaseAdmin || supabase;
      if (!client) throw new Error("Supabase client não inicializado");

      // Checagem final de race-condition: se outro processo gravou esse JID
      // entre a checagem inicial e aqui, NÃO sobrescreve nem cria duplicata.
      const dupSource = await checkCrmDuplicate(lead.remoteJid);
      if (dupSource) {
        sendLog(`⏭️ "${lead.name}" já estava no CRM (${dupSource}) — pulando`, "info");
        return;
      }

      const payload = {
        remoteJid: lead.remoteJid,
        nome_negocio: lead.name,
        telefone: lead.phones,
        ramo_negocio: lead.categories,
        endereco: lead.fullAddress,
        rating: lead.averageRating,
        reviews: lead.reviewCount,
        website: lead.website,
        instagram: lead.instagram,
        facebook: lead.facebook,
        instance_name: (await getEvolutionConfig()).instance || "sdr",
        updated_at: new Date().toISOString(),
      };

      const { error: insError } = await client.from("leads_extraidos").insert({
        ...payload,
        status: "novo",
        created_at: new Date().toISOString(),
      });
      if (insError) throw insError;
      sendLog(`✅ Salvo: ${lead.name}`, "success");
    } catch (err: any) {
      console.error("Erro ao salvar no Supabase (CRM):", err);
      sendLog(`❌ Falha ao salvar "${lead.name}": ${err.message || String(err)}`, "error");
    }
  }

  if (!settings.webhookEnabled || !settings.webhookUrl) return;
  if (settings.mode !== "realtime") return;
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
        const alpinePath = "/usr/bin/chromium-browser";
        if (fs.existsSync(alpinePath)) executablePath = alpinePath;
      }
    }

    const launchOptions: Record<string, unknown> = {
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
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
            const rMatch = textC.match(/(\d[.,]\d)\s*\(([\d.,k]+)\)/i);
            return {
              name: leadName,
              fullAddress: address,
              categories: category || "Comércio",
              averageRating: rMatch ? rMatch[1] : "",
              reviewCount: rMatch ? rMatch[2] : "",
            };
          }, lead.name);

          if (!cardData) continue;

          let phoneStr = "";
          let websiteStr = "";
          let instagramStr = "";
          let facebookStr = "";
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

              const extracted = await detailsPage.evaluate(() => {
                let phone = "";
                let website = "";
                let instagram = "";
                let facebook = "";

                const siteEls = Array.from(document.querySelectorAll('a[data-item-id="authority"], a[data-tooltip*="site" i], a[aria-label*="website" i], a[href^="http"]'));
                for (const a of siteEls) {
                  const v = (a as HTMLAnchorElement).href.toLowerCase();
                  if (v.includes("instagram.com")) { if (!instagram) instagram = (a as HTMLAnchorElement).href; }
                  else if (v.includes("facebook.com") || v.includes("fb.com")) { if (!facebook) facebook = (a as HTMLAnchorElement).href; }
                  else if (!v.includes("google.com") && !v.includes("gstatic.com") && !website) {
                    if (!a.hasAttribute("jslog")) website = (a as HTMLAnchorElement).href;
                  }
                }

                const authorityEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement;
                if (authorityEl?.href && !authorityEl.href.includes("google.com")) website = authorityEl.href;

                const tooltipEls = Array.from(document.querySelectorAll('[data-tooltip*="telefone" i], [aria-label*="telefone" i], [data-tooltip*="phone" i], [aria-label*="phone" i]'));
                for (const item of tooltipEls) {
                  const labelText = (item as HTMLElement).ariaLabel || item.getAttribute("data-tooltip") || "";
                  const match = labelText.match(/(?:\+?55\s?)?(?:\(?0?\d{2}\)?\s?)?(?:9\s?)?\d{4,5}[-\s.]?\d{4}/);
                  if (match) { phone = match[0].trim(); break; }
                }

                if (!phone) {
                  const bodyText = document.body.innerText || "";
                  const bodyMatch = bodyText.match(/(?:\+?55\s?)?(?:\(?0?\d{2}\)?\s?)?(?:9\s?)?\d{4,5}[-\s.]?\d{4}/);
                  if (bodyMatch) phone = bodyMatch[0].trim();
                }

                return { phone, website, instagram, facebook };
              });

              if (extracted) {
                phoneStr = extracted.phone;
                websiteStr = extracted.website;
                instagramStr = extracted.instagram;
                facebookStr = extracted.facebook;
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

          if (pass) {
            const jid = formatJid(phoneStr);
            // Filtro CRM: se o JID já está no leads_extraidos OU contacts, pula
            // SEM contar pro maxLeads, sem broadcast, sem salvar duplicata.
            const dupSource = jid ? await checkCrmDuplicate(jid) : null;
            if (dupSource) {
              crmSkipped++;
              sendLog(`⏭️ Já no CRM (${dupSource}): ${cardData.name}`, "info");
            } else {
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
              };
              leadsStore.push(finalLead);
              broadcast({ event: "new_lead", lead: finalLead, count: leadsStore.length });
              await saveLeadAndSync(finalLead, settings);
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
  /** Limite de leads — quando atingido o scraper sai limpo. */
  maxLeads?: number;
  automation_id?: string | null;
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
  if (isScraping) {
    if (opts.automation_id) currentAutomationId = opts.automation_id;
    return { ok: true, alreadyRunning: true };
  }
  lastSearchNiche = opts.niches[0];
  lastSearchRegion = opts.regions[0];
  currentAutomationId = opts.automation_id || null;
  // Fire-and-forget — runScraper tem try/finally que reseta isScraping=false.
  runScraper(opts.niches, opts.regions, {
    webhookUrl: opts.webhookUrl,
    webhookEnabled: opts.webhookEnabled,
    mode: opts.mode,
    filterEmpty: opts.filterEmpty,
    filterDuplicates: opts.filterDuplicates,
    filterLandlines: opts.filterLandlines,
    maxLeads: opts.maxLeads,
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
