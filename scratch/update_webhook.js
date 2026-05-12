
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const EVO_URL = process.env.EVOLUTION_API_URL;
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'sdr';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

async function updateWebhook() {
    console.log("--- ATUALIZANDO WEBHOOK NA EVOLUTION API ---");
    
    if (!EVO_URL || !EVO_KEY || !APP_URL) {
        console.error("ERRO: Verifique se NEXT_PUBLIC_APP_URL, EVOLUTION_API_URL e EVOLUTION_API_KEY estão no .env.local");
        return;
    }

    const webhookUrl = `${APP_URL.endsWith('/') ? APP_URL.slice(0, -1) : APP_URL}/api/webhooks/whatsapp`;
    console.log("Nova URL de Webhook:", webhookUrl);

    const headers = {
        'apikey': EVO_KEY,
        'Content-Type': 'application/json'
    };

    const body = {
        webhook: {
            url: webhookUrl,
            enabled: true,
            events: [
                "MESSAGES_UPSERT",
                "MESSAGES_UPDATE",
                "MESSAGES_DELETE",
                "SEND_MESSAGE",
                "CONNECTION_UPDATE"
            ],
            base64: true
        }
    };

    try {
        console.log(`Atualizando instância '${INSTANCE}'...`);
        const res = await axios.post(`${EVO_URL}/webhook/set/${INSTANCE}`, body, { headers });
        console.log("SUCESSO:", JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error("ERRO ao atualizar:", err.response?.status, JSON.stringify(err.response?.data, null, 2) || err.message);
    }
}

updateWebhook();
