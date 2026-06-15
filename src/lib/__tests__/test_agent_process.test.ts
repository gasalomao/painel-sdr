import './setupEnv';
import { test, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sistema-supabase.ridnii.easypanel.host';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey!);

import { POST } from '../../app/api/agent/process/route';
import { getInternalSecret, INTERNAL_SECRET_HEADER } from '../internal-auth';

test("simulate agent processing", async () => {
  const instanceName = '00000_sao_paulo';
  const remoteJid = '5511997765220@s.whatsapp.net';
  const text = 'Boa tarde, tudo bem?';
  const sessionId = '583ce268-704e-4dbb-bd87-d45cf2bc83ee';

  console.log("Starting agent process simulation...");
  
  const payload = {
    instanceName,
    remoteJid,
    text,
    sessionId
  };

  const fakeReq = new Request('http://localhost:3000/api/agent/process', {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_SECRET_HEADER]: getInternalSecret()
    },
    body: JSON.stringify(payload)
  });

  try {
    console.log("Calling agent route POST handler...");
    const res = await POST(fakeReq as any);
    console.log("Agent response status:", res.status);
    
    const body = await res.json();
    console.log("Agent response body:", JSON.stringify(body, null, 2));
    
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  } catch (err: any) {
    console.error("Agent simulation failed with error:", err);
    throw err;
  }
  // Timeout generoso: este é um teste de INTEGRAÇÃO AO VIVO (Supabase + IA +
  // Evolution reais). O agente tem buffer de mensagens de 15s, depois faz a
  // chamada de IA e o envio real pelo WhatsApp — 30s era curto demais e o teste
  // estourava no envio. 120s dá folga pro fluxo completo terminar.
}, 120000);
