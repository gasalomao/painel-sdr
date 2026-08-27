/**
 * LIVE TEST — race de restart do scraper (bug real do painel):
 *
 * Cenário do bug: usuário clica Iniciar, espera alguns segundos, clica de novo.
 * O forceRestart mata o run 1, mas o finally do run 1 rodava POR CIMA do run 2:
 * resetava isScraping, logava "🏁 Captação concluída · 0 leads" e marcava a
 * automação em erro — antes de o run 2 capturar qualquer coisa.
 *
 * Fix: guard de geração (runGeneration) — run substituído só fecha o browser
 * e sai ("♻️ Run substituído"), sem tocar no estado global.
 *
 * Este teste sobe DOIS runs reais (Puppeteer + Google Maps) e prova:
 *   1. Exatamente UM "🏁 Captação concluída" (do run 2).
 *   2. O guard dispara ("♻️ Run substituído").
 *   3. Estado final isScraping=false estável.
 *
 * Não testa sucesso de captura (Google pode bloquear) — testa o RACE.
 */
import { describe, it, expect } from "vitest";
import { startScraperRun, getStatus, stopScraper } from "../scraper-engine";
import fs from "fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSER_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

describe("Scraper restart race (live)", () => {
  it("restart com forceRestart não deixa o run antigo concluir por cima do novo", async () => {
    const hasBrowser = BROWSER_PATHS.some((p) => fs.existsSync(p)) || !!process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!hasBrowser) {
      console.log("Sem Chrome/Edge neste ambiente — pulando teste live de restart.");
      return;
    }

    const logs: string[] = [];
    const origLog = console.log;
    const spy = (msg: string, ...rest: unknown[]) => {
      if (typeof msg === "string" && msg.startsWith("[SCRAPER]")) logs.push(msg);
      origLog(msg, ...rest);
    };
    console.log = spy as typeof console.log;

    try {
      // Run 1 — nasce e vai ficar no meio do launch/primeira busca.
      const r1 = startScraperRun({
        niches: ["padaria"],
        regions: ["Belo Horizonte"],
        mode: "batch",
        maxLeads: 2,
        filterDuplicates: true,
        client_id: "00000000-0000-0000-0000-000000000001", // tenant default — não polui gasalomao
      });
      expect(r1.ok).toBe(true);

      // Deixa o run 1 chegar no meio do trabalho (a janela exata do bug).
      await sleep(5000);

      // Run 2 — forceRestart: mata o 1 e assume. Mesma semântica do clique
      // duplicado em Iniciar na automação de prospecção de sites.
      const r2 = startScraperRun({
        niches: ["padaria"],
        regions: ["Belo Horizonte"],
        mode: "batch",
        maxLeads: 2,
        filterDuplicates: true,
        client_id: "00000000-0000-0000-0000-000000000001",
        forceRestart: true,
      });
      expect(r2.ok).toBe(true);

      // Espera o run 2 terminar (browser real + Google Maps: até 150s).
      const deadline = Date.now() + 150_000;
      while (getStatus().isScraping && Date.now() < deadline) {
        await sleep(2000);
      }

      const joined = logs.join("\n");
      const concluidas = logs.filter((l) => l.includes("Captação concluída")).length;
      const substituidos = logs.filter((l) => l.includes("Run substituído")).length;

      // Debug do que aconteceu.
      origLog("=== LOGS DO SCRAPER (teste de race) ===\n" + joined + "\n=== FIM ===");

      expect(substituidos).toBe(1);           // guard disparou pro run 1
      expect(concluidas).toBe(1);             // SÓ o run 2 concluiu (run 1 calado)
      expect(getStatus().isScraping).toBe(false); // estado final estável
    } finally {
      stopScraper(); // garante que nada fica rodando se o teste falhar no meio
      console.log = origLog;
    }
  }, 200_000);
});
