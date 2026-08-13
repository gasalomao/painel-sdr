# Esquema do Banco de Dados

## Visão Geral

- **Banco**: PostgreSQL (via Supabase)
- **Extensões**: `pgcrypto` (UUID), `vector` (pgvector para RAG)
- **Tabelas**: 40 (33 canônicas + 7 opcionais)
- **RLS**: Desabilitado — isolamento via aplicação (`client_id` filtering)
- **Realtime**: ~15 tabelas com publicação ativa

## Extensões

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector (embeddings 768-dim)
```

## Modelo Multi-Tenant

```
clients (tenant root)
  id: UUID (PK)
  email: TEXT UNIQUE
  features: JSONB (14 feature flags)
  organizer_enabled, organizer_execution_hour
  default_ai_model: TEXT
```

**Coluna `client_id`** em 20 tabelas tenant-aware. Default: `00000000-0000-0000-0000-000000000001`.

**Triggers de auto-resolução** (migration 003):
- `chats_dashboard` → resolve via `instance_name`
- `messages` → resolve via `session_id → sessions.instance_name`
- `contacts` → resolve via `remote_jid → chats_dashboard`

---

## Tabelas Canônicas (33)

### 1. `clients` — Tenant Root

| Coluna | Tipo | Default | Notas |
|--------|------|---------|-------|
| id | UUID PK | `gen_random_uuid()` | |
| name | TEXT NOT NULL | | |
| email | TEXT NOT NULL UNIQUE | | |
| password_hash | TEXT | | PBKDF2-SHA256 |
| is_admin | BOOL | `false` | |
| is_active | BOOL | `true` | |
| default_ai_model | TEXT | | Override por cliente |
| features | JSONB NOT NULL | | `{chat:true, leads:false, ...}` |
| organizer_prompt | TEXT | | |
| organizer_enabled | BOOL | `true` | |
| organizer_execution_hour | INT | `20` | CHECK 0-23 |
| organizer_last_run | TIMESTAMPTZ | | Anti double-run |
| notes | TEXT | | Admin notes |
| created_at / updated_at | TIMESTAMPTZ | `now()` | |

### 2. `auth_sessions` — Sessões de Login

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| client_id | UUID FK→clients CASCADE | |
| impersonated_as | UUID FK→clients SET NULL | Admin impersonating |
| token_hash | TEXT UNIQUE | SHA-256 do JWT |
| user_agent | TEXT | |
| ip | TEXT | |
| expires_at | TIMESTAMPTZ NOT NULL | +30 dias |
| revoked_at | TIMESTAMPTZ | NULL = ativa |
| created_at | TIMESTAMPTZ | |

### 3. `leads_extraidos` — CRM Core (~60 colunas)

Tabela principal do CRM. Cada lead é um negócio prospectado.

| Grupo | Colunas | Source |
|-------|---------|--------|
| **Identificação** | id, remoteJid, nome_negocio, ramo_negocio, instance_name | Base |
| **Status CRM** | status (kanban), justificativa_ia, resumo_ia, ia_last_analyzed_at | Organizer IA |
| **Contato** | primeiro_contato_at, primeiro_contato_source, telefone, endereco, email | Base + migration 008 |
| **Qualificação** | avaliacao, reviews, rating, icp_score, lead_type, current_stage_index | Base |
| **Web** | website, categoria, instagram, facebook | Scraper |
| **IA** | intelligence JSONB, intelligence_at, last_analysis_hash, next_follow_up | Lead Intelligence |
| **Google Maps** | place_id, plus_code, lat, lng, cep, maps_url | Migration 011 |
| **Deep Capture** | reviews_detalhes, business_details, opening_hours, attributes, price_range, open_now, photos | Migration 009 |
| **Extended** | business_status, claimed, owner_name, year_established, total_photo_count, review_topics, featured_reviews, additional_categories, address_components | Migration 012 |
| **Prospecção** | opt_out (bool) | prospeccao_sites.sql |
| **Tenant** | client_id UUID FK→clients CASCADE | Migration 001 |

**Índices (11):** client, client_created, client_email (partial), client_status, remoteJid, icp_score, lead_type, primeiro_contato_source (partial), status, place_id (partial), lat_lng (partial), cep (partial), opt_out, no_website (partial).

### 4. `chats_dashboard` — Mensagens + Estado de Conversa

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | BIGSERIAL PK | |
| remote_jid | TEXT NOT NULL | WhatsApp JID |
| instance_name | TEXT | Default 'sdr' |
| message_id | TEXT UNIQUE | ID único da mensagem |
| sender_type | TEXT | customer / ai / human |
| content | TEXT | Conteúdo da mensagem |
| is_from_me | BOOL | Computed: sender_type IN (ai, human) |
| media_url, media_type, mimetype, message_type | TEXT | |
| quoted_id, quoted_text | TEXT | Mensagem respondida |
| contact_name, profile_pic_url | TEXT | Denormalizado |
| last_message | TEXT | Última mensagem da conversa |
| last_message_time | TIMESTAMPTZ | |
| unread_count | INT DEFAULT 0 | |
| status | TEXT DEFAULT 'bot_active' | bot_active / human_takeover / bot_paused |
| agent_id | INT | |
| client_id | UUID FK→clients CASCADE | |

### 5. `messages` — Message Store V2

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | BIGSERIAL PK | |
| session_id | UUID FK→sessions CASCADE | |
| message_id | TEXT UNIQUE | |
| sender | TEXT DEFAULT 'customer' | customer / ai / human |
| content | TEXT | |
| media_category, media_url, mimetype, file_name | TEXT | |
| file_size | BIGINT | |
| base64_content | TEXT | |
| delivery_status | TEXT | pending / sent / error |
| quoted_msg_id, quoted_text | TEXT | |
| raw_payload | JSONB | |
| chat_id | BIGINT FK→chats_dashboard CASCADE | |
| remote_jid, text, is_from_me, status | TEXT/BOOL | |
| instance_name | TEXT DEFAULT 'sdr' | |
| timestamp | TIMESTAMPTZ DEFAULT now() | |
| client_id | UUID FK→clients CASCADE | |

### 6. `sessions` — Estado de Sessão

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| contact_id | UUID FK→contacts CASCADE | |
| instance_name | TEXT DEFAULT 'sdr' | |
| agent_id | INT | |
| bot_status | TEXT DEFAULT 'bot_active' | bot_active / human_takeover / bot_paused |
| last_message_at | TIMESTAMPTZ | |
| variables | JSONB DEFAULT '{}' | Variáveis capturadas pelo funil |
| unread_count | INT DEFAULT 0 | |
| paused_by, paused_at, resume_at | TEXT/TIMESTAMPTZ | Controle de pausa |
| current_stage_id | UUID FK→agent_stages SET NULL | |
| current_stage | TEXT | |
| client_id | UUID FK→clients CASCADE | |
| **UNIQUE** | (contact_id, instance_name) | |

### 7. `contacts` — Contatos WhatsApp

| Coluna | Tipo |
|--------|------|
| id | UUID PK |
| remote_jid | TEXT NOT NULL UNIQUE |
| phone_number | TEXT |
| nome_negocio | TEXT |
| push_name | TEXT |
| profile_pic_url | TEXT |
| profile_pic_fetched_at | TIMESTAMPTZ |
| profile_pic | TEXT |
| lead_id | INT FK→leads_extraidos |
| tags | TEXT[] DEFAULT '{}' |
| notes | TEXT |
| client_id | UUID FK→clients CASCADE |

### 8. `agent_settings` — Agentes de IA

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | SERIAL PK | |
| name | TEXT DEFAULT 'Agente' | |
| main_prompt | TEXT | System prompt |
| role, personality, tone | TEXT | |
| target_model | TEXT | Modelo de IA |
| main_number | TEXT | |
| is_active | BOOL DEFAULT true | |
| is_24h | BOOL DEFAULT true | |
| away_message | TEXT | |
| schedules | JSONB DEFAULT '[]' | Horários de atendimento |
| options | JSONB DEFAULT '{}' | Google credentials, tools, etc. |
| lead_intelligence_enabled | BOOL DEFAULT false | |
| is_scheduler | BOOL DEFAULT false | Agendador de consultas |
| scheduler_config | JSONB | reminders, business_hours, calendar_id |
| client_id | UUID FK→clients CASCADE | |

### 9. `agent_stages` — Funil de Etapas

| Coluna | Tipo |
|--------|------|
| id | UUID PK |
| agent_id | INT FK→agent_settings CASCADE |
| title | TEXT NOT NULL |
| goal_prompt | TEXT |
| order_index | INT DEFAULT 0 |
| condition_variable, condition_operator, condition_value | TEXT |
| captured_variables | JSONB DEFAULT '[]' |
| client_id | UUID FK→clients CASCADE |

### 10-11. `agent_knowledge` + `agent_knowledge_chunks` — RAG

```sql
agent_knowledge:
  id UUID PK, agent_id INT FK, title TEXT, content TEXT

agent_knowledge_chunks:
  id UUID PK
  knowledge_id UUID FK→agent_knowledge CASCADE
  agent_id INT FK→agent_settings CASCADE  
  content TEXT NOT NULL
  embedding vector(768)          -- pgvector
  content_hash TEXT              -- dedup sha256
  embedding_model TEXT           -- migration 010
  
  -- HNSW index: vector_cosine_ops, m=16, ef_construction=64
```

### 12. `kanban_columns` — Pipeline Customizável

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| client_id | UUID FK→clients CASCADE | |
| status_key | TEXT NOT NULL | Ex: 'novo', 'fechado' |
| label | TEXT NOT NULL | Ex: 'Novo Lead' |
| color | TEXT | Hex ou preset |
| order_index | INT | Ordem no board |
| is_system | BOOL DEFAULT false | Não deletável (novo) |
| is_terminal | BOOL DEFAULT false | Status final (fechado/perdido) |
| **UNIQUE** | (client_id, status_key) | |

**Seed:** 7 colunas padrão para Default client.

### 13. `campaigns` — Campanhas de Disparo

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| name | TEXT NOT NULL | |
| instance_name | TEXT NOT NULL | |
| agent_id | INT FK→agent_settings SET NULL | |
| message_template | TEXT NOT NULL | Template com {{variaveis}} |
| min/max_interval_seconds | INT | Default 60/180 |
| allowed_start/end_hour | INT | Default 9/20 (BRT) |
| status | TEXT | draft/running/paused/done/cancelled |
| total_targets, sent_count, failed_count, skipped_count | INT | |
| personalize_with_ai | BOOL | |
| use_web_search | BOOL | |
| ai_model, ai_prompt | TEXT | |
| humanize_messages | BOOL | |
| media_url, media_type, media_caption, media_file_name, media_mimetype | TEXT | |
| campaign_type | TEXT DEFAULT 'disparo' | |
| automation_id | UUID | Link para automação |
| client_id | UUID FK→clients CASCADE | |

### 14. `campaign_targets` — Destinatários

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| campaign_id | UUID FK→campaigns CASCADE | |
| remote_jid | TEXT NOT NULL | |
| nome_negocio, ramo_negocio | TEXT | |
| next_send_at | TIMESTAMPTZ | Agendamento |
| status | TEXT DEFAULT 'pending' | pending/sent/failed/skipped |
| rendered_message | TEXT | Template processado |
| ai_input | TEXT | Contexto para IA |
| priority | INT DEFAULT 0 | Ordenação |
| **UNIQUE** | (campaign_id, remote_jid) | |

### 15. `automations` — Pipeline Completo

```sql
id UUID PK
name TEXT NOT NULL
agent_id INT FK→agent_settings
instance_name TEXT NOT NULL
niches JSONB NOT NULL DEFAULT '[]'      -- ['restaurante', 'dentista']
regions JSONB NOT NULL DEFAULT '[]'     -- ['São Paulo, SP']
scrape_filters JSONB DEFAULT '{}'
scrape_max_leads INT DEFAULT 200
dispatch_template TEXT
dispatch_personalize BOOL DEFAULT false
dispatch_humanize BOOL
dispatch_media_* TEXT
followup_steps JSONB NOT NULL DEFAULT '[]'  -- [{template, delay_hours}]
followup_ai_enabled BOOL
allowed_start_hour / allowed_end_hour INT
phase TEXT DEFAULT 'idle'              -- idle/scraping/campaigning/following/done
status TEXT DEFAULT 'draft'            -- draft/running/paused/done
campaign_id UUID                       -- Link para campaigns
followup_campaign_id UUID              -- Link para followup_campaigns
scraped_count INT
client_id UUID FK→clients CASCADE
```

### 16-17. `followup_campaigns` + `followup_targets`

```sql
followup_campaigns:
  id UUID PK
  steps JSONB NOT NULL DEFAULT '[]'    -- [{template, delay_hours}]
  min/max_interval_seconds INT          -- Default 60/240
  auto_execute BOOL DEFAULT false
  status TEXT DEFAULT 'draft'           -- active/paused/draft
  source_status TEXT DEFAULT 'follow-up' -- kanban pool
  humanize_messages, media_* TEXT

followup_targets:
  id UUID PK
  followup_campaign_id UUID FK→followup_campaigns CASCADE
  lead_id INT
  remote_jid TEXT NOT NULL
  current_step INT DEFAULT 0
  status TEXT DEFAULT 'pending'         -- pending/waiting/responded/exhausted
  UNIQUE (followup_campaign_id, remote_jid)
```

### 18. `appointments` — Agendamentos

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| client_id | UUID FK→clients CASCADE | |
| agent_id | INT FK→agent_settings SET NULL | |
| lead_id | INT FK→leads_extraidos SET NULL | |
| remote_jid | TEXT NOT NULL | |
| google_event_id | TEXT | Sync Google |
| title | TEXT NOT NULL | |
| start_at, end_at | TIMESTAMPTZ NOT NULL | |
| status | TEXT DEFAULT 'confirmed' | CHECK: confirmed/tentative/cancelled/completed/no_show |
| created_by | TEXT DEFAULT 'ia' | CHECK: ia/manual/google_sync |
| reminders_sent | JSONB DEFAULT '[]' | |
| location, attendees | TEXT/JSONB | Google fields |
| color_id | TEXT | Google color |

**Constraints únicos:**
- `appointments_google_event_id_unique` — partial WHERE google_event_id NOT NULL
- `appointments_no_overlap` — partial (agent_id, start_at) — anti-double-booking

### 19. `channel_connections` — Instâncias WhatsApp

| Coluna | Tipo | Notas |
|--------|------|-------|
| id | UUID PK | |
| provider | TEXT DEFAULT 'evolution' | evolution/evolution_go/whatsapp_cloud |
| instance_name | TEXT NOT NULL UNIQUE | |
| agent_id | INT FK→agent_settings SET NULL | |
| status | TEXT DEFAULT 'disconnected' | |
| provider_config | JSONB DEFAULT '{}' | phone_number_id, access_token, etc. |
| client_id | UUID FK→clients CASCADE | |

### 20. `ai_organizer_config` — Config Global IA

Singleton (id=1).

| Coluna | Tipo |
|--------|------|
| id | INT PK DEFAULT 1 |
| enabled | BOOL DEFAULT false |
| api_key | TEXT |
| openrouter_api_key | TEXT |
| gateway_endpoints | JSONB DEFAULT '[]' |
| model | TEXT |
| provider | TEXT DEFAULT 'Gemini' |
| execution_hour | INT DEFAULT 20 |
| last_run | TIMESTAMPTZ |
| app_url | TEXT |

### 21-23. Logs

```sql
ai_token_usage:       source, model, prompt_tokens, completion_tokens, cost_usd
ai_organizer_runs:    batch_id, status, chats_analyzed, leads_moved
historico_ia_leads:   status_antigo, status_novo, razao, resumo, batch_id
campaign_logs:        campaign_id, message, level (info/success/warning/error)
followup_logs:        followup_campaign_id, message, level
automation_logs:      automation_id, kind, level, message, remote_jid
webhook_logs:         instance_name, event, payload JSONB
```

### 24. Outras

```sql
chat_buffers:         (remote_jid, instance_name) PK — agrupamento de mensagens
app_settings:         key TEXT PK, value TEXT — config key-value
provider_credentials: id TEXT PK, content JSONB — backup de OAuth
ai_pricing_cache:     key TEXT PK, payload JSONB — preços LiteLLM
ai_control:           remote_jid TEXT PK, is_paused BOOL — pausa IA por JID
agent_batch_locks:    agent_id INT PK — lock de concorrência
```

---

## Tabelas Opcionais (7) — migration_ai_first_os.sql

Módulos opt-in não inclusos no SETUP_COMPLETO.sql:

```sql
knowledge_base:        Second brain global (title, content, category, tags)
antivacuo_rules:       Regras de re-engajamento (hours_without_reply, max_attempts)
antivacuo_logs:        Log de tentativas de re-engajamento
sales_insights:        Pains/objections extraídos (insight_type, content, confidence)
handoff_queue:         Transferência IA→humano (reason, priority, ai_summary)
pos_venda_campaigns:   Pós-venda/NPS (trigger_days, message_template, avg_nps)
pos_venda_contacts:    Contatos pós-venda (nps_score, feedback, indicated_contacts)
```

---

## Funções RPC

### `match_knowledge_chunks` — RAG Vector Search

```sql
CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding vector(768),
  p_agent_id int,
  p_client_id uuid,
  match_count int DEFAULT 5,
  min_similarity float DEFAULT 0.35
)
RETURNS TABLE (
  id uuid,
  knowledge_id uuid,
  title text,
  content text,
  chunk_index int,
  similarity float
)
```

**Uso:** `supabase.rpc('match_knowledge_chunks', { query_embedding, p_agent_id, ... })`

---

## Diagrama de Relacionamentos

```
clients (tenant)
├─ auth_sessions
├─ kanban_columns
├─ agent_settings
│  ├─ agent_stages
│  ├─ agent_knowledge → agent_knowledge_chunks (vector)
│  ├─ appointments ← (leads_extraidos, google_sync)
│  └─ channel_connections
├─ leads_extraidos ← (intelligence, scraper)
├─ contacts → sessions → messages → chats_dashboard
├─ campaigns → campaign_targets, campaign_logs
├─ followup_campaigns → followup_targets, followup_logs
├─ automations → automation_logs
├─ appointments
├─ ai_token_usage, ai_organizer_runs, historico_ia_leads
├─ chat_buffers, webhook_logs
└─ [opcional: knowledge_base, antivacuo_*, sales_insights, handoff_queue, pos_venda_*]

Global: app_settings, ai_organizer_config, ai_pricing_cache, provider_credentials
```

**Cadeia de joins principal:**
```
messages.session_id → sessions.id
sessions.contact_id → contacts.id  
contacts.lead_id → leads_extraidos.id
*.instance_name → channel_connections.instance_name → channel_connections.client_id
```
