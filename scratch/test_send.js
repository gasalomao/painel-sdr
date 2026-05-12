
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const EVO_URL = process.env.EVOLUTION_API_URL;
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'sdr';

async function testSendMessage() {
    console.log("--- TESTANDO ENVIO DE MENSAGEM ---");
    
    // Altere para o seu número de teste se necessário
    const number = "557391810230@s.whatsapp.net"; 
    const text = "Teste de envio via script SDR - " + new Date().toISOString();

    const headers = {
        'apikey': EVO_KEY,
        'Content-Type': 'application/json'
    };

    const body = {
        number,
        text,
        delay: 1000,
        linkPreview: true
    };

    try {
        console.log(`Enviando para ${number}...`);
        const res = await axios.post(`${EVO_URL}/message/sendText/${INSTANCE}`, body, { headers });
        console.log("SUCESSO:", JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error("ERRO ao enviar:", err.response?.status, JSON.stringify(err.response?.data, null, 2) || err.message);
    }
}

testSendMessage();
