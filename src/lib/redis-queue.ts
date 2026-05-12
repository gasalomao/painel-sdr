import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

/**
 * REDIS STABILITY LAYER V3
 * Solução definitiva para ETIMEDOUT e "Unhandled error event" no Next.js
 */

const redisConfig: any = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  username: process.env.REDIS_USERNAME,
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  commandTimeout: 3000,
  enableOfflineQueue: false, // Não enfileira comandos se estiver offline
  lazyConnect: true,         // Não conecta automaticamente no import
  
  retryStrategy(times: number) {
    if (times > 2) {
      console.warn(`[Redis] Timeout persistente. Desabilitando Redis temporariamente.`);
      return null; 
    }
    return 1000;
  },
};

// Pattern de Singleton Robusto com Suporte a HMR
const globalForRedis = global as unknown as { redisInstance: IORedis | undefined };

export function getRedisConnection() {
  if (!globalForRedis.redisInstance) {
    console.log(`[Redis] Criando cliente para ${redisConfig.host}...`);
    
    const instance = new IORedis(redisConfig);
    
    // TRATAMENTO DE ERRO IMEDIATO
    instance.on('error', (err) => {
      // Isso impede o crash "Unhandled error event"
      if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
        console.warn(`[Redis] Falha de conexão: ${err.message}`);
      } else {
        console.error('[Redis] Erro inesperado:', err.message);
      }
    });

    instance.on('connect', () => {
      console.log('[Redis] Conectado!');
    });

    // Inicia a conexão manualmente (devido ao lazyConnect) de forma safe
    instance.connect().catch((err) => {
      console.warn('[Redis] Erro no connect inicial:', err.message);
    });

    globalForRedis.redisInstance = instance;
  }
  
  return globalForRedis.redisInstance;
}

// Fila de Mensagens (Opcional, o chat agora usa envio direto)
export const MESSAGE_QUEUE_NAME = 'whatsapp_messages';
let messageQueue: Queue | null = null;

export function getMessageQueue() {
  if (!messageQueue) {
    messageQueue = new Queue(MESSAGE_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: true },
    });

    // BULLMQ também emite erros que precisam ser capturados!
    messageQueue.on('error', (err) => {
      console.warn('[BullMQ] Erro na Fila (silenciado):', err.message);
    });
  }
  return messageQueue;
}

// ÚLTIMO RECURSO: Captura global de eventos não tratados do ioredis no processo Node
if (typeof process !== 'undefined') {
  process.on('unhandledRejection', (reason: any) => {
    if (reason?.message?.includes('ioredis') || reason?.message?.includes('ETIMEDOUT')) {
      // Ignora silenciosamente rejeições do Redis não tratadas
    }
  });

  // Previne o crash fatal por erro de evento não tratado
  const originalEmit = process.emit;
  process.emit = function (this: any, name: any, ...args: any[]) {
    if (name === 'error' && args[0]?.message?.includes('ioredis')) {
      return false;
    }
    return (originalEmit as any).apply(this, [name, ...args]);
  } as any;
}

// Utilitários Safe (Não quebram se o Redis estiver fora)
export const AI_PAUSE_PREFIX = 'ai_paused:';

export async function pauseAiForJid(remoteJid: string, instanceName: string, seconds: number) {
  try {
    const redis = getRedisConnection();
    if (redis.status !== 'ready') return;
    
    const key = `${AI_PAUSE_PREFIX}${instanceName}:${remoteJid}`;
    if (seconds > 0) {
      await redis.set(key, 'true', 'EX', seconds);
    } else {
      await redis.set(key, 'true'); 
    }
  } catch (err: any) {
    console.warn(`[Redis] Falha silenciada em pauseAi: ${err.message}`);
  }
}

export async function resumeAiForJid(remoteJid: string, instanceName: string) {
  try {
    const redis = getRedisConnection();
    if (redis.status !== 'ready') return;
    const key = `${AI_PAUSE_PREFIX}${instanceName}:${remoteJid}`;
    await redis.del(key);
  } catch (err: any) {
    console.warn(`[Redis] Falha silenciada em resumeAi: ${err.message}`);
  }
}

export async function isAiPaused(remoteJid: string, instanceName: string): Promise<boolean> {
  try {
    const redis = getRedisConnection();
    if (redis.status !== 'ready') return false;
    
    const key = `${AI_PAUSE_PREFIX}${instanceName}:${remoteJid}`;
    const paused = await redis.get(key);
    return !!paused;
  } catch (err: any) {
    return false;
  }
}
