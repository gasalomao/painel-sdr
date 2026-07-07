/**
 * Backup DUPLO de contas conectadas — arquivo local (FS) + Supabase.
 *
 * PROBLEMA QUE RESOLVE: os auth-files do conector OAuth (CLIProxyAPI) e os
 * tokens DeepSeek vivem SÓ em arquivos locais (.gateway-proxy/auths/,
 * .deepseek-chat/tokens.json). Sem volume persistente no Easypanel, eles SOMEM
 * a cada redeploy — o usuário precisa reconectar tudo de novo.
 *
 * SOLUÇÃO: esta camada faz BACKUP no Supabase (tabela `provider_credentials`)
 * após cada mudança (login/pause/resume/delete) e RESTAURA pro FS antes do
 * proxy subir. Assim as contas sobrevivem a redeploys mesmo sem volume.
 *
 * Dois provedores:
 *   - gateway: auth-files OAuth (.json em auths/, auths-paused/, auth-meta/)
 *   - deepseek: tokens.json + subscriptions.json
 *
 * Tudo é fire-and-forget (não bloqueia o fluxo principal). Falhas são logadas,
 * nunca quebram o login. Server-only.
 */

import fs from "fs";
import path from "path";
import { supabaseAdmin } from "@/lib/supabase_admin";

// ============================================================================
// GATEWAY (conector OAuth — CLIProxyAPI)
// ============================================================================

/**
 * Caminhos do gateway-proxy-manager. Espelhados aqui (não importo o módulo pra
 * evitar acoplamento — se aquele mudar a base dir, este acompanha lendo o mesmo
 * resolver. Definidos como consts simples; atualizar juntos se mudar.
 */
function gatewayBaseDir(): string {
  const candidates = [
    process.env.GATEWAY_PROXY_DIR,
    path.join(process.cwd(), ".gateway-proxy"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch {}
  }
  return path.join(process.cwd(), ".gateway-proxy");
}

const GW_DIRS = {
  auths: () => path.join(gatewayBaseDir(), "auths"),
  paused: () => path.join(gatewayBaseDir(), "auths-paused"),
  meta: () => path.join(gatewayBaseDir(), "auth-meta"),
};

/** Lê todos os auth-files (ativos + pausados + metadados) e sobe pro Supabase. */
export async function backupGatewayAuthFiles(): Promise<number> {
  let count = 0;
  const rows: Array<{ id: string; content: any; paused: boolean; label: string | null }> = [];
  const readDir = (dir: string, paused: boolean) => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, name), "utf8");
        const content = JSON.parse(raw);
        // Lê o apelido do sidecar de metadado (se existir).
        let label: string | null = null;
        try { const m = JSON.parse(fs.readFileSync(path.join(GW_DIRS.meta(), `${name}`), "utf8")); label = m?.label || null; } catch {}
        rows.push({ id: `gw:${name}`, content, paused, label });
      } catch { /* arquivo corrompido — pula */ }
    }
  };
  readDir(GW_DIRS.auths(), false);
  readDir(GW_DIRS.paused(), true);

  for (const r of rows) {
    try {
      const { error } = await supabaseAdmin.from("provider_credentials").upsert({
        id: r.id,
        provider: "gateway",
        content: r.content,
        label: r.label,
        paused: r.paused,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
      if (!error) count++;
    } catch { /* não-fatal */ }
  }
  return count;
}

/**
 * Restaura os auth-files do Supabase pro FS. Chamada ANTES de startProxy()
 * no boot — o proxy lê o auth-dir ao subir e carrega as contas. Idempotente:
 * só escreve arquivos que não existem localmente (não sobrescreve os vivos).
 */
export async function restoreGatewayAuthFiles(): Promise<number> {
  let count = 0;
  let data: any[] = [];
  try {
    const res = await supabaseAdmin.from("provider_credentials").select("*").eq("provider", "gateway");
    data = res.data || [];
  } catch { return 0; }
  if (!data.length) return 0;

  for (const row of data) {
    // O id é "gw:<filename>" — extrai o nome do arquivo.
    const name = String(row.id).replace(/^gw:/, "");
    if (!name) continue;
    const targetDir = row.paused ? GW_DIRS.paused() : GW_DIRS.auths();
    const targetPath = path.join(targetDir, name);
    // Só restaura se NÃO existe localmente (preserva estado vivo atual).
    if (fs.existsSync(targetPath)) { count++; continue; }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(row.content, null, 2), "utf8");
      // Restaura o metadado (apelido) se tiver label.
      if (row.label) {
        fs.mkdirSync(GW_DIRS.meta(), { recursive: true });
        fs.writeFileSync(path.join(GW_DIRS.meta(), name), JSON.stringify({ label: row.label, createdAt: row.created_at }), "utf8");
      }
      count++;
    } catch { /* não-fatal */ }
  }
  return count;
}

/** Remove um auth-file do backup (quando a conta é deletada localmente). */
export async function deleteGatewayAuthFromBackup(name: string): Promise<void> {
  try { await supabaseAdmin.from("provider_credentials").delete().eq("id", `gw:${name}`); } catch {}
}

// ============================================================================
// DEEPSEEK (tokens + subscriptions)
// ============================================================================

function deepseekBaseDir(): string {
  const candidates = [
    process.env.DEEPSEEK_CHAT_DIR,
    path.join(process.cwd(), ".deepseek-chat"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch {}
  }
  return path.join(process.cwd(), ".deepseek-chat");
}

/** Backup dos tokens + subscriptions DeepSeek pro Supabase. */
export async function backupDeepSeekData(): Promise<void> {
  const dir = deepseekBaseDir();
  for (const file of ["tokens.json", "subscriptions.json"]) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const content = JSON.parse(raw);
      await supabaseAdmin.from("provider_credentials").upsert({
        id: `ds:${file}`,
        provider: "deepseek",
        content,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
    } catch { /* arquivo não existe ou corrompido — pula */ }
  }
}

/** Restaura tokens + subscriptions DeepSeek do Supabase pro FS. Idempotente. */
export async function restoreDeepSeekData(): Promise<number> {
  let count = 0;
  let data: any[] = [];
  try {
    const res = await supabaseAdmin.from("provider_credentials").select("*").eq("provider", "deepseek");
    data = res.data || [];
  } catch { return 0; }
  if (!data.length) return 0;

  const dir = deepseekBaseDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const row of data) {
    const file = String(row.id).replace(/^ds:/, "");
    if (!file) continue;
    const targetPath = path.join(dir, file);
    // Só restaura se não existe localmente.
    if (fs.existsSync(targetPath)) { count++; continue; }
    try {
      fs.writeFileSync(targetPath, JSON.stringify(row.content, null, 2), "utf8");
      count++;
    } catch { /* não-fatal */ }
  }
  return count;
}

// ============================================================================
// Restauração completa (chamada no boot do proxy/conector)
// ============================================================================

/**
 * Restaura TODAS as credenciais (gateway + DeepSeek) do Supabase pro FS.
 * Chamada antes de iniciar o proxy no boot. Idempotente e silenciosa.
 * Retorna um resumo do que foi restaurado (pra log).
 */
export async function restoreAllCredentialsFromSupabase(): Promise<{ gateway: number; deepseek: number }> {
  const [gateway, deepseek] = await Promise.all([
    restoreGatewayAuthFiles().catch(() => 0),
    restoreDeepSeekData().catch(() => 0),
  ]);
  if (gateway > 0 || deepseek > 0) {
    console.log(`[auth-backup] Restaurado do Supabase: ${gateway} auth-file(s) gateway, ${deepseek} arquivo(s) DeepSeek.`);
  }
  return { gateway, deepseek };
}
