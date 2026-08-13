# Canais de WhatsApp

O sistema abstrai 3 provedores de WhatsApp sob uma interface unificada, com roteamento automático e fallback entre providers.

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                   channel.ts (router)                    │
│                                                         │
│  sendMessage(jid, text, instance)                       │
│  sendMedia(jid, caption, media, instance)               │
│  checkWhatsAppNumbers(numbers, instance)                │
│  getStatus(instance) / fetchProfilePicture(jid, inst)   │
└───────────────┬─────────────────────────────────────────┘
                │
    ┌───────────▼───────────┐
    │ channel_connections   │
    │ (provider per instance)│
    └──┬────────┬───────────┘
       │        │           │
┌──────▼──┐ ┌──▼────────┐ ┌▼──────────────┐
│Evo V2   │ │Evo GO     │ │WhatsApp Cloud │
│(Baileys)│ │(whatsmeow)│ │(Meta official)│
│Node.js  │ │Go         │ │REST API       │
└─────────┘ └───────────┘ └───────────────┘
```

## Provedores

### 1. Evolution API V2 (Baileys)

| Aspecto | Detalhe |
|---------|---------|
| Stack | Node.js + Baileys |
| Protocolo | WebSocket (não-oficial) |
| Instância | Uma por número |
| Config | `app_settings`: `evolution_url`, `evolution_api_key` |
| Auth | API Key header |
| Media | URL ou base64 |

**Endpoints principais:**
```
POST /message/sendText/{instance}
POST /message/sendMedia/{instance}
GET  /instance/fetchInstances
POST /chat/findContacts/{instance}
```

### 2. Evolution GO (whatsmeow)

| Aspecto | Detalhe |
|---------|---------|
| Stack | Go + whatsmeow |
| Protocolo | WebSocket (não-oficial) |
| Banco | 2 databases PostgreSQL (GORM) |
| Config | `app_settings`: `evolution_go_url`, `evolution_go_key` |
| Auth | API Key header |
| Status | Migração em andamento (Phase 2-3 completas) |

### 3. WhatsApp Cloud API (Meta Oficial)

| Aspecto | Detalhe |
|---------|---------|
| Stack | REST API oficial da Meta |
| Auth | `access_token` + `phone_number_id` |
| Config | `channel_connections.provider_config` (JSONB) |
| Limite | 1000 conversas/24h (tier padrão) |
| Templates | Necessário para primeira mensagem fora de 24h |

**Endpoints principais:**
```
POST graph.facebook.com/v21.0/{phone_number_id}/messages
POST graph.facebook.com/v21.0/{phone_number_id}/media
```

## Roteamento e Fallback

```typescript
// channel.ts
async sendMessage(remoteJid, text, instanceName) {
  const channel = await resolveChannel(instanceName);
  
  // Provider resolution
  if (channel.provider === 'whatsapp_cloud') {
    return whatsappCloud.send(channel.config, remoteJid, text);
  }
  
  // Evolution: primary + fallback
  const primary = channel.provider === 'evolution_go' 
    ? evolutionGo 
    : evolutionV2;
  const fallback = channel.provider === 'evolution_go'
    ? evolutionV2
    : evolutionGo;
    
  try {
    return await primary.send(instanceName, remoteJid, text);
  } catch {
    return await fallback.send(instanceName, remoteJid, text);
  }
}
```

## Resolução de Instância

```typescript
resolveChannel(instanceName) {
  // Cache de 30s
  → SELECT * FROM channel_connections WHERE instance_name = ?
  → Retorna: { provider, config, agent_id, client_id }
}

resolveInstanceFromPhoneNumberId(phoneId) {
  // Para Cloud API webhooks
  → SELECT * FROM channel_connections 
    WHERE provider = 'whatsapp_cloud' 
    AND provider_config->>'phone_number_id' = ?
}
```

## Mídia

### Anti-Link Fix

```typescript
async function ensureBase64(media: MediaData): Promise<MediaData> {
  // Evolution GO mostra link em vez de imagem
  // Solução: baixar server-side, converter para base64
  
  if (media.url && !media.base64) {
    const buf = await fetchUrlAsBase64(media.url); // 60s timeout, 100MB
    media.base64 = buf;
    delete media.url;
  }
  return media;
}
```

### Tipos de Mídia Suportados

| Tipo | Content-Type | Limite |
|------|-------------|--------|
| Imagem | image/jpeg, image/png, image/webp | 5MB |
| Áudio | audio/ogg, audio/mp3 | 16MB |
| Vídeo | video/mp4 | 16MB |
| Documento | application/pdf, etc | 100MB |
| Esticker | image/webp (sticker) | 1MB |

### Cache de Mídia

```typescript
// LRU cache: 50 items, 6h TTL
mediaBase64Cache: Map<string, {base64, ts}>
// Evita re-download de fotos de produto repetidas
```

## Mensagens

### Estrutura Unificada

```typescript
interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

interface MediaData {
  url?: string;        // OU
  base64?: string;     // Um dos dois
  mimetype: string;
  caption?: string;
  fileName?: string;
}
```

### Manual Send Registry

**Arquivo**: `src/lib/manual-send-registry.ts`

Quando o Evolution ecoa `fromMe=true`, o sistema precisa distinguir:

```typescript
// 3 registros com TTL de 2 minutos:
registerManualSend(jid, text)  // Humano enviou pelo chat
registerAiSend(jid, text)      // IA enviou resposta
registerPendingAutomatedSend(jid, text)  // Campanha/follow-up

// No webhook:
isManualSend(from, text) → true? → apenas persiste, não processa
isAiSend(from, text) → true? → já foi processado
isPendingAutomatedSend(from, text) → true? → marca como sent
```

## Status e Conexão

```typescript
getStatus(instanceName) → {
  state: 'open' | 'close' | 'connecting',
  qrCode?: string,  // base64 QR para conectar
}
```

### QR Code Flow

```
1. POST /api/instances/create {instanceName}
   → Evolution API cria instância → retorna QR code
2. Frontend mostra QR na tela /whatsapp
3. Usuário escaneia com celular
4. Evolution conecta → webhook atualiza status='open'
5. channel_connections.status = 'connected'
```

## Perfil de Contato

```typescript
fetchProfilePicture(remoteJid, instanceName)
  → GET Evolution /chat/profilePicture
  → Cache em contacts.profile_pic_url

bulkSyncProfilePics(instanceName)
  → V2: POST /chat/findContacts/{instance}
  → GO: GET /message/contacts
  → Batch update contacts (50 por vez)
```

## Webhooks

### Recebimento de Mensagens

```
Evolution API → POST /api/webhooks/evolution-go
  Body: { event, instance, data: { key: { remoteJid, fromMe }, message: {...} } }
  
Processamento:
1. Validar webhook (API key ou secret)
2. Resolver instance → client_id
3. Se fromMe=true → verificar registries (manual/ai/automated)
4. Persistir em chats_dashboard + messages
5. Se mensagem de cliente (fromMe=false):
   a. Session lookup
   b. Bot status check
   c. Se bot_active → process via /api/agent/process
```

### WhatsApp Cloud API Webhook

```
Meta → POST /api/webhooks/whatsapp
  Body: { entry: [{ changes: [{ value: { messages: [...] } }] }] }
  
Processamento:
1. Verificar X-Hub-Signature-256
2. Resolver phoneNumberId → instance
3. Mesmo fluxo do Evolution webhook
```

## Provider Config (DB)

```sql
-- channel_connections
provider_config JSONB:
{
  -- WhatsApp Cloud:
  "phone_number_id": "...",
  "access_token": "...",
  "waba_id": "...",
  "verify_token": "..."
  
  -- Evolution: config via app_settings (global)
}
```
