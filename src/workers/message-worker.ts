import { Worker, Job } from 'bullmq';
import * as dotenv from 'dotenv';
import path from 'path';

/**
 * Worker Process: Este arquivo deve ser rodado como um processo separado (Node.js).
 * Responsável por processar a fila de mensagens e o handoff IA.
 */

// 1. CARREGAR VARIÁVEIS DE AMBIENTE IMEDIATAMENTE (Antes de qualquer import de lib interna)
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// 2. IMPORTS DINÂMICOS OU DEPOIS DO DOTENV
// Usamos require para garantir a ordem de carregamento das variáveis de ambiente
const { getRedisConnection, MESSAGE_QUEUE_NAME } = require('../lib/redis-queue');
const channel = require('../lib/channel');
const { supabaseAdmin: supabase } = require('../lib/supabase_admin');

console.log(`[Worker] Inicializando engine...`);
console.log(`[Worker] Redis Host: ${process.env.REDIS_HOST}`);

const worker = new Worker(
  MESSAGE_QUEUE_NAME,
  async (job: Job) => {
    const { remoteJid, text, media, instanceName, messageDbId, legacyDbId } = job.data;
    
    console.log(`[Worker] Processando job ${job.id} | Mensagem para ${remoteJid}`);

    try {
      let evoData;
      // 1. Enviar real via Evolution API
      if (media && media.base64) {
        evoData = await channel.sendMedia(remoteJid, text || "", {
          type: media.type,
          base64: media.base64,
          fileName: media.fileName,
          mimetype: media.mimetype
        }, instanceName);
      } else {
        evoData = await channel.sendMessage(remoteJid, text, instanceName);
      }

      const msgId = evoData?.key?.id || evoData?.data?.key?.id;

      // 2. Atualizar status no Supabase (V2)
      if (messageDbId) {
        await supabase
          .from("messages")
          .update({ 
            message_id: msgId, 
            delivery_status: 'sent',
            raw_payload: evoData 
          })
          .eq("id", messageDbId);
      }

      // 3. Atualizar status no chats_dashboard (Legado)
      if (legacyDbId) {
        await supabase
          .from("chats_dashboard")
          .update({ 
            message_id: msgId, 
            status_envio: 'sent' 
          })
          .eq("id", legacyDbId);
      }

      console.log(`[Worker] Job ${job.id} concluído com sucesso. Msg ID: ${msgId}`);
      return { success: true, msgId };

    } catch (err: any) {
      console.error(`[Worker] Falha no job ${job.id}:`, err.message);
      
      // Marcar erro no banco
      if (messageDbId) {
        await supabase.from("messages").update({ delivery_status: 'error' }).eq("id", messageDbId);
      }
      if (legacyDbId) {
        await supabase.from("chats_dashboard").update({ status_envio: 'error' }).eq("id", legacyDbId);
      }

      throw err; 
    }
  },
  {
    connection: getRedisConnection(),
    concurrency: 5,
  }
);

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} falhou definitivamente:`, err);
});

process.on('SIGTERM', async () => {
  console.log('[Worker] Encerrando graciosamente...');
  await worker.close();
  process.exit(0);
});
