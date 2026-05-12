const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://oyksatwtyyqjueuivsdy.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sua_key_aqui_se_necessario'; // Vou tentar pegar do env se o agente tiver acesso, senão o agente me dirá.
// Na verdade, vou ler do arquivo .env.local se existir.

const fs = require('fs');
const path = require('path');

function getEnv() {
    try {
        const envPath = path.join(__dirname, '..', '.env.local');
        const content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split('\n');
        const env = {};
        lines.forEach(l => {
            const [k, v] = l.split('=');
            if (k && v) env[k.trim()] = v.trim();
        });
        return env;
    } catch { return {}; }
}

async function debug() {
    const env = getEnv();
    const url = env.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl;
    const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        console.error("URL ou Key não encontradas no .env.local");
        return;
    }

    const supabase = createClient(url, key);

    console.log("Checando tabela chats_dashboard...");
    const { data, error } = await supabase
        .from('chats_dashboard')
        .select('instance_name, count(*)')
        .limit(10);
        
    // Supabase JS doesn't support count(*) grouped like this easily in basic select, so let's just get raw data
    const { data: raw, error: err2 } = await supabase
        .from('chats_dashboard')
        .select('instance_name')
        .limit(100);

    if (err2) {
        console.error("Erro na query:", err2);
    } else {
        const counts = {};
        raw.forEach(r => {
            counts[r.instance_name] = (counts[r.instance_name] || 0) + 1;
        });
        console.log("Mensagens por instância (amostra de 100):", counts);
    }
}

debug();
