/**
 * Helpers pra mascarar PII (telefones, JIDs) em logs.
 *
 * Por que existe: console.log com remoteJid completo (5511999998888@s.whatsapp.net)
 * + conteúdo da mensagem do cliente vai parar em log de produção (Easypanel, stdout,
 * arquivos de log). LGPD/GDPR pede que dados pessoais não sejam expostos sem motivo
 * técnico claro.
 *
 * Estratégia: mantém os primeiros 4 dígitos (suficiente pra distinguir país/DDD)
 * e os últimos 2 (suficiente pra agrupar mesmo lead no log) — esconde o miolo.
 *
 * Em modo debug agressivo, pode-se setar DEBUG_PII=1 pra desabilitar a máscara.
 */

const DEBUG_PII = process.env.DEBUG_PII === "1";

/** "5511999998888@s.whatsapp.net" → "5511***88@s.whatsapp.net" */
export function maskJid(jid: string | null | undefined): string {
  if (!jid) return "";
  if (DEBUG_PII) return jid;
  const at = jid.indexOf("@");
  const phone = at > 0 ? jid.slice(0, at) : jid;
  const suffix = at > 0 ? jid.slice(at) : "";
  if (phone.length < 8) return jid; // nada pra mascarar
  const head = phone.slice(0, 4);
  const tail = phone.slice(-2);
  return `${head}***${tail}${suffix}`;
}

/** Trunca texto pra log evitando vazar conversa inteira. */
export function truncForLog(text: string | null | undefined, max = 60): string {
  if (!text) return "";
  if (DEBUG_PII) return text;
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
