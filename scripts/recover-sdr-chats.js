const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const OLD_INSTANCE = 'sdr';
const NEW_INSTANCE = '00000_Sdr_numero_bahia';
const CLIENT_ID = '00000000-0000-0000-0000-00000000a001'; // Fallback se não achar na sessão

async function run() {
  console.log(`Buscando mensagens órfãs da instância '${OLD_INSTANCE}' na tabela messages...`);

  // Pega todas as mensagens da instância antiga
  const { data: messages, error: msgErr } = await supabase
    .from('messages')
    .select('*')
    .eq('instance_name', OLD_INSTANCE);

  if (msgErr) {
    console.error("Erro ao buscar messages:", msgErr);
    return;
  }

  console.log(`Encontradas ${messages.length} mensagens para recuperar.`);

  if (messages.length === 0) {
    console.log("Nada a recuperar.");
    return;
  }

  // Pega as sessões dessas mensagens para descobrir o remote_jid
  const sessionIds = [...new Set(messages.map(m => m.session_id).filter(Boolean))];
  
  const sessions = [];
  const SESS_BATCH = 100;
  for (let i = 0; i < sessionIds.length; i += SESS_BATCH) {
    const batchIds = sessionIds.slice(i, i + SESS_BATCH);
    const { data: sessBatch, error: sessErr } = await supabase
      .from('sessions')
      .select('id, contact_id, client_id, contacts!inner(remote_jid)')
      .in('id', batchIds);

    if (sessErr) {
      console.error("Erro ao buscar sessions no batch:", sessErr);
      return;
    }
    sessions.push(...sessBatch);
  }

  console.log(`Encontradas ${sessions.length} sessões associadas.`);

  const sessionMap = new Map();
  for (const s of sessions) {
    const jid = Array.isArray(s.contacts) ? s.contacts[0]?.remote_jid : s.contacts?.remote_jid;
    sessionMap.set(s.id, {
      remote_jid: jid,
      client_id: s.client_id
    });
  }

  let recovered = 0;
  const dashPayloads = [];

  for (const m of messages) {
    if (!m.session_id) continue;
    
    const sess = sessionMap.get(m.session_id);
    if (!sess || !sess.remote_jid) {
      console.warn(`Sessão não encontrada ou sem remote_jid para message_id: ${m.message_id}`);
      continue;
    }

    const payload = {
      client_id: sess.client_id || CLIENT_ID,
      remote_jid: sess.remote_jid,
      instance_name: NEW_INSTANCE,
      message_id: m.message_id,
      sender_type: m.sender === 'ai' ? 'ai' : m.sender,
      content: m.content || m.text || "",
      status_envio: m.delivery_status || 'sent',
      media_url: m.media_url,
      media_type: m.media_type || m.media_category,
      mimetype: m.mimetype || m.media_mimetype,
      created_at: m.created_at,
      status: 'bot_active'
    };

    dashPayloads.push(payload);
  }

  console.log(`Preparadas ${dashPayloads.length} payloads para chats_dashboard.`);

  // Inserir em lotes de 1000
  const BATCH_SIZE = 1000;
  for (let i = 0; i < dashPayloads.length; i += BATCH_SIZE) {
    const batch = dashPayloads.slice(i, i + BATCH_SIZE);
    
    // Ignorar duplicatas se já existirem (upsert)
    const { error: insErr } = await supabase
      .from('chats_dashboard')
      .upsert(batch, { onConflict: 'message_id', ignoreDuplicates: true });

    if (insErr) {
      console.error(`Erro ao inserir lote ${i}:`, insErr);
    } else {
      recovered += batch.length;
      console.log(`Lote inserido. Total recuperado: ${recovered}`);
    }
  }

  console.log("Recuperação concluída!");
}

run();
