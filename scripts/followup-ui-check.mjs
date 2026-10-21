/* Local-only UI regression check. Start npm run dev, then node scripts/followup-ui-check.mjs. All browser API/database requests use fixtures; no messages are sent. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', quiet: true });

const sample = { id: 'qa-campaign', name: 'Retorno comercial · Outubro', instance_name: 'Comercial', ai_enabled: true, ai_model: 'qa-model', ai_prompt: 'Preservar o tom da conversa.', steps: [{ day_offset: 2, template: 'Olá {{nome_empresa}}, podemos conversar?' }, { day_offset: 4, template: 'Qual é o melhor horário para você?' }], min_interval_seconds: 40, max_interval_seconds: 90, allowed_start_hour: 9, allowed_end_hour: 18, auto_execute: true, source_status: 'follow-up', status: 'active', total_enrolled: 24, total_sent: 18, total_responded: 7, total_exhausted: 2, created_at: '2026-10-21T12:00:00Z' };
const target = { id: 'qa-target', remote_jid: '5511999990000@s.whatsapp.net', nome_negocio: 'Clínica Horizonte', current_step: 1, last_sent_at: '2026-10-21T12:00:00Z', next_send_at: '2026-10-23T12:00:00Z', status: 'waiting', error_message: null, last_rendered: 'Olá Clínica Horizonte, podemos conversar?' };
const lead = { id: 1, remoteJid: target.remote_jid, nome_negocio: target.nome_negocio, ramo_negocio: 'Saúde', status: 'follow-up' };

(async () => {
  const { SignJWT } = await import('jose');
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(secret, 'Configure o segredo local de autenticação sem expô-lo.');
  const token = await new SignJWT({ clientId: 'qa-local', actorId: 'qa-local', email: 'qa@example.com', name: 'Demonstração local', isAdmin: true, impersonating: false, features: {}, sessionId: 'qa-local' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(secret));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'sdr_session', value: token, domain: 'localhost', path: '/' }]);
    const writes = [];
    const errors = [];
    let campaigns = [];
    await context.route('**/rest/v1/**', async route => {
      const url = route.request().url();
      const rows = url.includes('channel_connections') ? [{ instance_name: 'Comercial' }] : url.includes('kanban_columns') ? [{ status_key: 'follow-up', label: 'Retomar contato', color: '#6ee7b7' }] : url.includes('leads_extraidos') ? [lead] : url.includes('followup_logs') ? [{ id: 1, followup_campaign_id: sample.id, message: 'Mensagem enviada. Aguardando o próximo intervalo.', level: 'success', created_at: '2026-10-21T12:00:00Z' }] : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    await context.routeWebSocket(/supabase/, ws => ws.close());
    await context.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') writes.push({ path, method: request.method(), body: request.postDataJSON() });
      let data = { ok: true, data: [], notifications: [], count: 0 };
      if (path === '/api/auth/session') data = { authenticated: true, clientId: 'qa-local', name: 'Demonstração local', isAdmin: true, features: {} };
      else if (path === '/api/followup') data = request.method() === 'GET' ? { success: true, campaigns } : { success: true };
      else if (path.endsWith('/preview')) data = { success: true, preview: { target, ai_used: true, step_index: 0, history_msg_count: 2, history: 'Histórico de demonstração local.', rendered: target.last_rendered, final_message: 'Olá! Qual é o melhor horário para conversarmos?' } };
      else if (path.endsWith('/enroll')) data = { success: true, enrolled: 1 };
      else if (path.endsWith('/tick')) data = { success: true, processed: 1 };
      else if (path.startsWith('/api/followup/')) data = { success: true, campaign: campaigns.find(c => path.endsWith(c.id)) || sample, targets: [target] };
      else if (path === '/api/whatsapp') data = { success: true, instances: [{ instanceName: 'Comercial', profileName: 'WhatsApp Comercial' }] };
      else if (path === '/api/ai-models') data = { success: true, models: [{ id: 'qa-model', name: 'Modelo de demonstração' }] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const before = process.argv.includes('--before');
    const folder = '.impeccable/review/follow-up';
    mkdirSync(folder, { recursive: true });
    const results = [];
    for (const width of before ? [1440, 390] : [1440, 390, 320]) {
      campaigns = [sample, { ...sample, id: 'qa-paused', name: 'Contato com consultórios', status: 'paused', ai_enabled: false, auto_execute: false, total_enrolled: 12, total_sent: 5, total_responded: 1, total_exhausted: 0 }];
      await page.setViewportSize({ width, height: width === 1440 ? 1080 : 844 });
      await page.goto('http://localhost:3000/follow-up');
      await page.getByText(sample.name, { exact: true }).first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const suffix = width === 1440 ? 'desktop' : width === 390 ? 'mobile' : '320';
      await page.screenshot({ path: `${folder}/${before ? 'before-' : ''}${suffix}.png`, animations: 'disabled' });
      if (before) {
        await page.getByRole('button', { name: 'Nova Campanha', exact: true }).click();
        await page.screenshot({ path: `${folder}/before-form-${suffix}.png`, animations: 'disabled' });
        await page.keyboard.press('Escape');
        continue;
      }
      await page.getByRole('button', { name: `Ver detalhes de ${sample.name}`, exact: true }).click();
      await page.getByText(target.nome_negocio, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Ver logs em tempo real', exact: true }).first().click();
      await page.getByRole('button', { name: /Ver envios \(18\)/ }).click();
      await page.getByRole('button', { name: 'Falhas (0)', exact: true }).click();
      await page.getByText('Nenhum envio neste filtro.', { exact: true }).waitFor();
      await page.getByRole('button', { name: `Editar ${sample.name}`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Nome da campanha', { exact: true }).fill('Retorno revisado');
      assert.equal(await dialog.getByLabel('Mensagem da etapa 1', { exact: true }).inputValue(), sample.steps[0].template);
      await page.screenshot({ path: `${folder}/form-${suffix}.png`, animations: 'disabled' });
      await dialog.getByLabel('Mensagem da etapa 1', { exact: true }).fill('');
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      await dialog.getByLabel('Mensagem da etapa 1', { exact: true }).fill(sample.steps[0].template);
      await dialog.getByRole('button', { name: 'Adicionar etapa', exact: true }).click();
      await dialog.getByLabel('Mensagem da etapa 3', { exact: true }).fill('Etapa temporária');
      await dialog.getByRole('button', { name: 'Remover etapa 3', exact: true }).click();
      await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const saved = writes.findLast(w => w.path === `/api/followup/${sample.id}` && w.body?.name === 'Retorno revisado');
      assert.deepEqual(saved.body, { name: 'Retorno revisado', instance_name: sample.instance_name, ai_enabled: sample.ai_enabled, ai_model: sample.ai_model, ai_prompt: sample.ai_prompt, steps: sample.steps, min_interval_seconds: sample.min_interval_seconds, max_interval_seconds: sample.max_interval_seconds, allowed_start_hour: sample.allowed_start_hour, allowed_end_hour: sample.allowed_end_hour, auto_execute: sample.auto_execute, source_status: sample.source_status });
      await page.getByRole('button', { name: 'Nova campanha', exact: true }).click();
      await dialog.getByLabel('Nome da campanha', { exact: true }).fill('Nova campanha de teste');
      await dialog.getByRole('button', { name: 'Criar campanha', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert(writes.some(w => w.path === '/api/followup' && w.method === 'POST' && w.body?.steps.length === 3));
      const overflow = await page.evaluate(() => [...document.querySelectorAll('main, section, article, button, input, textarea')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(e => `${e.tagName}:${e.textContent.trim().slice(0, 35)}`));
      assert.deepEqual(overflow, [], `Overflow em ${width}px`);
      results.push({ width, editPayloadPreserved: true, validationVisible: true, addRemoveStep: true, create: true, overflow });
    }
    assert.deepEqual(errors, [], 'Erros de execução no navegador');
    writeFileSync(`${folder}/${before ? 'before-' : ''}results.json`, JSON.stringify({ synthetic: true, results, errors }, null, 2));
    console.log(JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
