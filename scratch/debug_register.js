
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const EVO_URL = process.env.EVOLUTION_API_URL;
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = 'sdr';
const WEBHOOK_URL = 'https://c836-179-42-65-125.ngrok-free.app/api/webhooks/whatsapp?agentId=1';

async function testRegister() {
    console.log("--- TESTANDO REGISTRO DE WEBHOOK ---");
    const headers = { 'apikey': EVO_KEY, 'Content-Type': 'application/json' };
    const body = {
        webhook: {
            url: WEBHOOK_URL,
            enabled: true,
            events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_DELETE", "SEND_MESSAGE", "CONNECTION_UPDATE"],
            base64: true
        }
    };

    try {
        const res = await axios.post(`${EVO_URL}/webhook/set/${INSTANCE}`, body, { headers });
        console.log("SUCESSO:", res.data);
    } catch (err) {
        console.error("ERRO:", err.response?.status);
        console.error("BODY:", err.response?.data);
    }
}

testRegister();
