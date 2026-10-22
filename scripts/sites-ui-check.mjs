/* Local synthetic UI check. Requires the existing dev server; all APIs and external traffic are intercepted. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { SignJWT } from 'jose';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });
const before = process.argv.includes('--before');
const functional = process.argv.includes('--functional');
const folder = '.impeccable/review/sites';
const id = '00000000-0000-4000-8000-000000000001';
const project = { id, client_id: 'qa-local', name: 'Padaria Central · demonstração', slug: 'padaria-central', status: 'draft', client_context: { name: 'Padaria Central' }, cta: { type: 'whatsapp', value: '' }, instructions: '', model_mode: 'auto', model_id: null, selected_skill_ids: [], current_revision_id: null, published_url: null, last_published_at: null, updated_at: '2026-10-21T12:00:00Z', created_at: '2026-10-21T12:00:00Z' };
const writes = [], errors = [], projectReads = [];
let empty = false, failure = false;
async function main() {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(secret, 'Segredo local de autenticação ausente.');
  const token = await new SignJWT({ clientId: 'qa-local', actorId: 'qa-local', name: 'Demonstração local', isAdmin: true, impersonating: false, features: {}, sessionId: 'qa-local' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(secret));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'sdr_session', value: token, domain: 'localhost', path: '/' }]);
    await context.routeWebSocket(/supabase/, ws => ws.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) {
        if (request.method() !== 'GET') writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
        if (url.pathname === '/api/sites' && failure) return route.fulfill({ status: 503, json: { error: 'Falha simulada na lista de sites.' } });
        let data = { ok: true, success: true, data: [], notifications: [], count: 0 };
        if (url.pathname === '/api/auth/session') data = { authenticated: true, clientId: 'qa-local', actorId: 'qa-local', sessionId: 'qa-local', name: 'Demonstração local', isAdmin: true, features: {} };
        if (url.pathname === '/api/sites') data = request.method() === 'POST' ? { project } : { projects: empty ? [] : [project, { ...project, id: '00000000-0000-4000-8000-000000000002', name: 'Consultório com um nome bastante longo para conferir a leitura em telas pequenas', status: 'published', published_url: 'https://example.com/consultorio', model_mode: 'quality' }] };
        if (url.pathname === `/api/sites/${id}`) { projectReads.push(url.pathname); data = { project }; }
        if (url.pathname.endsWith('/models')) data = { models: [{ id: 'example/model', name: 'Modelo de demonstração', supportsTools: true, isFree: true, inputModalities: ['text'], contextLength: 64000 }] };
        for (const key of ['files', 'runs', 'messages', 'assets', 'skills', 'builds', 'deployments', 'revisions', 'leads']) {
          if (url.pathname.endsWith(`/${key}`)) data = { [key]: key === 'files' ? {} : [] };
        }
        return route.fulfill({ json: data });
      }
      if (url.pathname.includes('/rest/v1/')) return route.fulfill({ json: [] });
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    mkdirSync(folder, { recursive: true });
    const results = [];
    for (const width of before ? [1440, 390] : [1680, 1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto('http://localhost:3000/sites');
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (!functional) await page.screenshot({ path: `${folder}/${before ? 'before-' : ''}list-${width}.png`, animations: 'disabled' });
      if (!before) {
        await page.getByRole('link', { name: `Editar ${project.name}`, exact: true }).waitFor();
        await page.getByRole('button', { name: `Excluir site "${project.name}"`, exact: true }).click();
        await page.getByRole('dialog', { name: 'Excluir site', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
        assert.equal(writes.length, 0, 'Cancelar exclusão não escreve');
      }
      await page.getByRole('button', { name: 'Criar site', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      if (!functional) await page.screenshot({ path: `${folder}/${before ? 'before-' : ''}create-${width}.png`, animations: 'disabled' });
      if (!before) {
        await dialog.getByLabel('Nome do projeto', { exact: true }).fill('Projeto de teste');
        await dialog.getByLabel('Descreva o site (obrigatório)', { exact: true }).fill('Uma página para apresentar o negócio e seus serviços.');
        assert.equal(await dialog.getByRole('button', { name: 'Criar e gerar site', exact: true }).isEnabled(), true);
        assert.equal(await dialog.locator('select').nth(1).inputValue(), 'auto');
        const overflows = await page.evaluate(() => [...document.querySelectorAll('h1,h2,button,[role="dialog"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(e => e.textContent.trim().slice(0, 60)));
        assert.deepEqual(overflows, [], `Sem recorte em ${width}px`);
      }
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await page.goto(`http://localhost:3000/sites/${id}`);
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor({ timeout: 12000 }).catch(async error => { await page.screenshot({ path: `${folder}/editor-load-failure.png` }); console.log((await page.locator('main').innerText()).slice(0, 2000)); throw error; });
      await page.getByText('Como posso ajudar com seu site?', { exact: true }).waitFor();
      if (!functional) await page.screenshot({ path: `${folder}/${before ? 'before-' : ''}editor-${width}.png`, animations: 'disabled' });
      if (!before) {
        await page.getByLabel('Seu pedido para a IA', { exact: true }).fill('Ajuste o título da página.');
        await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Enviar')?.disabled);
        assert.equal(await page.getByRole('button', { name: 'Enviar', exact: true }).isEnabled(), true);
        const loadedReads = projectReads.length;
        // Um snapshot não pode reiniciar seu próprio efeito de carregamento.
        await page.waitForTimeout(250);
        assert.equal(projectReads.length, loadedReads, 'Carregamento do editor estabiliza sem consultas repetidas');
        if (width < 1536) {
          const initialTab = page.getByRole('tab', { name: width >= 1024 ? 'Prévia do site' : 'Conversa', exact: true });
          assert.equal(await initialTab.getAttribute('aria-selected'), 'true');
          await initialTab.focus();
          await initialTab.press('End');
          assert.equal(await page.getByRole('tab', { name: 'Ajustes', exact: true }).getAttribute('aria-selected'), 'true');
          await page.getByRole('tab', { name: 'Ajustes', exact: true }).press('Home');
          assert.equal(await initialTab.getAttribute('aria-selected'), 'true');
          await page.getByRole('tab', { name: 'Prévia do site', exact: true }).click();
          await page.getByRole('tab', { name: 'Código', exact: true }).waitFor();
          await page.getByRole('tab', { name: 'Ajustes', exact: true }).click();
          await page.getByRole('tabpanel', { name: 'Ajustes do projeto', exact: true }).waitFor();
          await page.getByRole('tab', { name: width >= 1024 ? 'Prévia do site' : 'Conversa', exact: true }).click();
          assert.equal(await page.getByLabel('Seu pedido para a IA', { exact: true }).inputValue(), 'Ajuste o título da página.');
        }
        const overflow = await page.evaluate(() => document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth);
        assert.equal(overflow, false, `Editor sem scroll horizontal em ${width}px`);
      }
      results.push({ width });
    }
    if (!before) {
      empty = true;
      await page.goto('http://localhost:3000/sites');
      await page.getByRole('heading', { name: 'Seu primeiro site começa aqui', exact: true }).waitFor();
      if (!functional) await page.screenshot({ path: `${folder}/empty.png`, animations: 'disabled' });
      failure = true;
      await page.reload();
      await page.getByRole('alert').filter({ hasText: 'Não foi possível concluir a operação' }).waitFor();
      failure = false;
      await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
      await page.getByRole('heading', { name: 'Seu primeiro site começa aqui', exact: true }).waitFor();
      assert.deepEqual(errors, [], 'Sem erros de execução no navegador');
      assert.deepEqual(writes, [], 'Sem escritas reais nem submissão durante verificação visual');
    }
    const report = { synthetic: true, before, results, errors, writes };
    writeFileSync(`${folder}/${before ? 'before-' : ''}results.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
