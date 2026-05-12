
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const EVO_URL = process.env.EVOLUTION_API_URL;
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'sdr';

async function testEvo() {
    console.log("--- TESTANDO CONEXÃO EVOLUTION API ---");
    console.log("URL:", EVO_URL);
    console.log("Instância:", INSTANCE);

    if (!EVO_URL || !EVO_KEY) {
        console.error("ERRO: Variáveis de ambiente não configuradas no .env.local");
        return;
    }

    const headers = {
        'apikey': EVO_KEY,
        'Content-Type': 'application/json'
    };

    try {
        // 1. Check Connection State
        console.log("\n1. Verificando estado da conexão...");
        const connRes = await axios.get(`${EVO_URL}/instance/connectionState/${INSTANCE}`, { headers });
        console.log("Estado:", JSON.stringify(connRes.data, null, 2));

        if (connRes.data.instance?.state !== 'open' && connRes.data.state !== 'open') {
            console.warn("AVISO: A instância NÃO está aberta. Mensagens não serão enviadas.");
        } else {
            console.log("SUCESSO: Instância aberta.");
        }

        // 2. Fetch Instances
        console.log("\n2. Listando instâncias...");
        const instRes = await axios.get(`${EVO_URL}/instance/fetchInstances`, { headers });
        console.log("Instâncias encontradas:", instRes.data.length);

        // 3. Test Webhook
        console.log("\n3. Verificando Webhooks da instância...");
        const webRes = await axios.get(`${EVO_URL}/webhook/find/${INSTANCE}`, { headers });
        console.log("Webhooks:", JSON.stringify(webRes.data, null, 2));

    } catch (err) {
        console.error("ERRO na requisição:", err.response?.status, err.response?.data || err.message);
    }
}

testEvo();
