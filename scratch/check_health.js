
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkLogs() {
  try {
    console.log("--- ULTIMOS LOGS DE WEBHOOK ---");
    const { data: logs, error: lError } = await supabase.from("webhook_logs").select("*").order("created_at", { ascending: false }).limit(5);
    if (lError) console.error("Erro ao ler logs:", lError);
    else console.log(JSON.stringify(logs, null, 2));

    console.log("\n--- LOCKS ATIVOS ---");
    const { data: locks, error: lockErr } = await supabase.from("agent_batch_locks").select("*");
    if (lockErr) console.error("Erro ao ler locks:", lockErr);
    else console.log(JSON.stringify(locks, null, 2));

    console.log("\n--- CONFIGURAÇÃO DE ORGANIZAÇÃO ---");
    const { data: org } = await supabase.from("ai_organizer_config").select("*").eq("id", 1).single();
    console.log("Status API Key Global:", org?.api_key ? "Configurada" : "Vazia");

  } catch (err) {
    console.error("Erro fatal no script:", err);
  }
}

checkLogs();
