/* Local-only: start npm run dev, then node scripts/tokens-ui-check.mjs. API/database responses are synthetic; no real writes or paid calls. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { SignJWT } from 'jose';

dotenv.config({ path: '.env.local', quiet: true });
const before = process.argv.includes('--before');
const folder = '.impeccable/review/tokens';
const rate = 5.1;
const sources = [
  { source: 'agent', total: 1240000, cost: 4.8, calls: 320, prompt: 940000, completion: 300000 },
  { source: 'disparo', total: 280000, cost: 1.2, calls: 88, prompt: 200000, completion: 80000 },
  { source: 'followup', total: 160000, cost: 0.6, calls: 42, prompt: 100000, completion: 60000 },
  { source: 'organizer', total: 90000, cost: 0.3, calls: 24, prompt: 70000, completion: 20000 },
  { source: 'other', total: 30000, cost: 0.1, calls: 6, prompt: 20000, completion: 10000 },
];
const fixture = {
  success: true, isAdminView: true,
  totals: { prompt: 1330000, completion: 470000, total: 1800000, cost: 7, costBrl: 35.7, calls: 480, brlRate: rate },
  pricingState: { source: 'db', fetchedAt: Date.now() - 3600000, modelCount: 1832 },
  bySource: sources,
  bySourceLabel: [
    { ...sources[0], label: 'Atendimento comercial · demonstração' },
    { ...sources[1], label: 'Campanha de prospecção · demonstração' },
    { ...sources[2], label: 'Retorno de propostas · demonstração' },
  ],
  byModel: [
    { model: 'google/gemini-2.5-flash', total: 1500000, cost: 6, calls: 400, prompt: 1100000, completion: 400000, priceKnown: true, input_per_1m: 0.3, output_per_1m: 2.5 },
    { model: 'openai/gpt-4.1-mini', total: 300000, cost: 1, calls: 80, prompt: 230000, completion: 70000, priceKnown: true, input_per_1m: 0.4, output_per_1m: 1.6 },
    { model: 'modelo-sem-preco', total: 1200, cost: 0, calls: 1, prompt: 800, completion: 400, priceKnown: false, input_per_1m: null, output_per_1m: null },
  ],
  byDayStacked: Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10), total: 250000, cost: 1, calls: 68, agent: 0.6 + i * 0.03, disparo: 0.15, followup: 0.1, organizer: 0.08, other: 0.07 })),
  byClient: [{ client_id: 'qa-local', name: 'Cliente de demonstração', total: 1800000, cost: 7, costBrl: 35.7, calls: 480, prompt: 1330000, completion: 470000 }],
  recent: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, source: sources[i].source, source_label: 'Atendimento de demonstração', model: 'google/gemini-2.5-flash', prompt_tokens: 1600, completion_tokens: 300, total_tokens: 1900, cost_usd: 0.0012, cost_brl: 0.00612, priceKnown: true, created_at: '2026-10-21T12:00:00Z' })),
};

async function main() {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(secret, 'Configure o segredo local de autenticação sem expô-lo.');
  const token = await new SignJWT({ clientId: 'qa-local', actorId: 'qa-local', name: 'Demonstração local', isAdmin: true, impersonating: false, features: {}, sessionId: 'qa-local' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(secret));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'sdr_session', value: token, domain: 'localhost', path: '/' }]);
    const writes = [], reads = [], errors = [];
    let admin = true, fail = false, empty = false, notReady = false;
    await context.routeWebSocket(/supabase/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (request.method() !== 'GET') writes.push({ path: url.pathname, method: request.method() });
        let data = { ok: true, success: true, data: [], notifications: [], count: 0 };
        if (url.pathname === '/api/auth/session') data = { authenticated: true, clientId: 'qa-local', name: 'Demonstração local', isAdmin: admin, features: {} };
        if (url.pathname === '/api/tokens') {
          reads.push(url.search);
          if (fail) return route.fulfill({ status: 503, json: { success: false, error: 'Falha simulada' } });
          data = { ...fixture, notReady, isAdminView: admin, byClient: admin ? fixture.byClient : undefined };
          if (empty) data = { ...data, totals: { prompt: 0, completion: 0, total: 0, cost: 0, costBrl: 0, calls: 0, brlRate: rate }, bySource: [], bySourceLabel: [], byModel: [], byDayStacked: [], recent: [], byClient: [] };
        }
        if (url.pathname === '/api/tokens/pricing') data = { success: true, ...fixture.pricingState };
        if (url.pathname === '/api/tokens/recalc') data = { success: true, updated: 5, scanned: 5, unknownModels: ['modelo-sem-preco'] };
        if (url.pathname === '/api/tokens/diagnose') data = { ok: false, checks: [{ ok: true, step: 'Leitura', message: 'Leitura disponível.' }, { ok: false, step: 'Modelo', message: 'Preço não encontrado.', hint: 'Atualize os preços.' }] };
        return route.fulfill({ status: 200, json: data });
      }
      if (url.pathname.includes('/rest/v1/')) return route.fulfill({ json: [] });
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    mkdirSync(folder, { recursive: true });
    const results = [];
    for (const width of before ? [1440, 390] : [1440, 768, 390, 320]) {
      admin = true; empty = false; notReady = false;
      await page.setViewportSize({ width, height: width === 1440 ? 1080 : 844 });
      await page.goto('http://localhost:3000/tokens');
      await page.getByText('Cliente de demonstração', { exact: true }).waitFor();
      await page.locator('.recharts-surface').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const suffix = width === 1440 ? 'desktop' : width === 390 ? 'mobile' : String(width);
      await page.screenshot({ path: `${folder}/${before ? 'before-' : ''}${suffix}.png`, animations: 'disabled' });
      if (before) continue;
      await page.getByRole('heading', { name: 'Evolução do custo', exact: true }).evaluate(async element => {
        const scroller = document.querySelector('[aria-label="Consumo de IA"]');
        scroller.scrollTop += element.closest('section').getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.screenshot({ path: `${folder}/analysis-${suffix}.png`, animations: 'disabled' });
      const content = page.getByRole('region', { name: 'Consumo de IA' });
      assert.equal(await page.getByRole('button', { name: '7 dias', exact: true }).getAttribute('aria-pressed'), 'true');
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/tokens'), page.getByRole('button', { name: '30 dias', exact: true }).click()]);
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/tokens'), page.getByRole('button', { name: 'Todo o período', exact: true }).click()]);
      assert.equal(reads.at(-1), '', 'Todo o período não envia limites de data');
      await page.getByRole('button', { name: 'Atualizar preços', exact: true }).click();
      await page.getByRole('button', { name: 'Recalcular histórico', exact: true }).click();
      await page.getByText(/5 de 5 chamadas/).waitFor();
      await page.getByRole('button', { name: 'Diagnosticar', exact: true }).click();
      await page.getByText('Preço não encontrado.', { exact: true }).waitFor();
      await page.screenshot({ path: `${folder}/tools-${suffix}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: 'Fechar diagnóstico', exact: true }).click();
      await page.getByRole('heading', { name: 'Últimas chamadas', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${folder}/history-${suffix}.png`, animations: 'disabled' });
      const overflow = await page.evaluate(() => {
        const root = document.querySelector('[aria-label="Consumo de IA"]');
        return [...root.querySelectorAll('section, article, button, h2, h3, figure')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(e => `${e.tagName}:${e.textContent.trim().slice(0, 30)}`);
      });
      assert.deepEqual(overflow, [], `Overflow em ${width}px`);
      assert.equal(await content.evaluate(el => el.scrollWidth <= el.clientWidth), true, `Scroll horizontal global em ${width}px`);
      results.push({ width, overflow, filters: true, tools: true });
    }
    if (!before) {
      admin = false;
      await page.reload();
      await page.getByRole('heading', { name: 'Modelos e preços', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Custos por cliente', exact: true }).count(), 0);
      empty = true;
      await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click();
      await page.getByText('Nenhuma chamada neste período.', { exact: true }).waitFor();
      notReady = true;
      await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click();
      await page.getByText('Registro de tokens indisponível', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Tokens IA', exact: true }).last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${folder}/empty-mobile.png`, animations: 'disabled' });
      fail = true;
      await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Não foi possível carregar o consumo' }).waitFor();
      fail = false;
      await page.getByRole('button', { name: 'Atualizar dados', exact: true }).click();
      await page.getByRole('button', { name: 'Atualizar dados', exact: true }).waitFor({ state: 'visible' });
      assert(writes.some(w => w.path === '/api/tokens/pricing' && w.method === 'POST'));
      assert(writes.some(w => w.path === '/api/tokens/recalc' && w.method === 'POST'));
      assert.deepEqual(errors, [], 'Erros no navegador');
    }
    const report = { synthetic: true, results, errors, writes, adminIsolation: !before, emptyAndFailure: !before };
    writeFileSync(`${folder}/${before ? 'before-' : ''}results.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
