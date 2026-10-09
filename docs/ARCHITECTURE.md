# Arquitetura Técnica — Vidrão Site Studio

**Documento:** Diagramas e fluxos de dados detalhados  
**Data:** 2026-10-09  
**Versão:** 1.0

---

## 1. ARQUITETURA GERAL DO SISTEMA

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (Next.js 16)                       │
│                                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   Chat UI    │  │ Files Tree   │  │   Editor     │  │   Preview   │ │
│  │              │  │              │  │   (Monaco)   │  │   (iframe)  │ │
│  │ - Messages   │  │ - Real-time  │  │ - Syntax     │  │ - Live      │ │
│  │ - Input      │  │ - SSE sync   │  │ - Diff view  │  │   reload    │ │
│  │ - Thinking   │  │ - Highlight  │  │ - Autocmp    │  │ - Isolated  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                 │                  │                 │         │
└─────────┼─────────────────┼──────────────────┼─────────────────┼─────────┘
          │                 │                  │                 │
          │                 │                  │                 │
          ↓                 ↓                  ↓                 ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                         NEXT.JS API ROUTES                               │
│                                                                           │
│  /api/sites/[projectId]/                                                │
│  ├─ POST   /runs                 → Criar nova run                       │
│  ├─ GET    /messages              → Listar histórico chat               │
│  ├─ GET    /files?run_id=X        → Buscar checkpoint                   │
│  ├─ PUT    /files                 → Salvar edição manual                │
│  └─ GET    /runs/[runId]/activities?stream=true → SSE de eventos        │
│                                                                           │
└────────────┬───────────────────────────────┬────────────────────────────┘
             │                               │
             │ (HTTP/JSON)                   │ (Server-Sent Events)
             │                               │
             ↓                               ↓
┌──────────────────────────────┐   ┌─────────────────────────────────────┐
│    SUPABASE (PostgreSQL)     │   │      SUPABASE REALTIME              │
│                              │   │                                     │
│  Tables:                     │   │  Channels:                          │
│  ├─ website_projects         │   │  ├─ run-activities:${runId}        │
│  ├─ website_runs             │   │  └─ Triggers: postgres_changes     │
│  ├─ website_messages         │   │                                     │
│  ├─ website_run_activities   │◄──┼─ Detecta INSERT/UPDATE             │
│  ├─ website_revisions        │   │  Publica evento via WebSocket      │
│  ├─ website_builds           │   │  Converte para SSE no Edge         │
│  └─ website_deployments      │   │                                     │
│                              │   │                                     │
│  RLS: Multi-tenant por       │   │  Auth: JWT token do Supabase       │
│  client_id (user.id)         │   │                                     │
└──────────────┬───────────────┘   └─────────────────────────────────────┘
               │
               │ (SQL queries via Supabase client)
               │
               ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                          BULLMQ WORKER                                   │
│                     (src/lib/sites/worker.ts)                           │
│                                                                           │
│  Process: sites-worker                                                   │
│  Queue: website_runs                                                     │
│  Concurrency: 3                                                          │
│                                                                           │
│  Job Lifecycle:                                                          │
│  1. Claim run (lease 2min)                                              │
│  2. Load checkpoint from DB                                              │
│  3. Initialize WebsiteAgentRuntime                                       │
│  4. Execute IA loop (chat → tools → checkpoint)                         │
│  5. Build & QA validation                                                │
│  6. Save final revision                                                  │
│  7. Mark run as completed                                                │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────┐       │
│  │           WebsiteAgentRuntime                                │       │
│  │                                                              │       │
│  │  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │       │
│  │  │   AI Provider  │  │  Tools Engine  │  │  Checkpoint  │ │       │
│  │  │                │  │                │  │   Manager    │ │       │
│  │  │ - OpenRouter   │  │ - list         │  │ - Save       │ │       │
│  │  │ - Gemini       │  │ - read         │  │ - Restore    │ │       │
│  │  │ - NVIDIA       │  │ - write        │  │ - Diff       │ │       │
│  │  │ - DeepSeek     │  │ - patch        │  │ - Compress   │ │       │
│  │  │                │  │ - create       │  │              │ │       │
│  │  │ Budget: 250k   │  │ - delete       │  │ Budget: 80   │ │       │
│  │  │ tokens output  │  │ - search       │  │ turns max    │ │       │
│  │  └────────┬───────┘  └────────┬───────┘  └──────┬───────┘ │       │
│  │           │                   │                  │          │       │
│  │           └───────────────────┼──────────────────┘          │       │
│  │                               │                             │       │
│  │                               ↓                             │       │
│  │                    ┌─────────────────────┐                 │       │
│  │                    │   Event Emitter     │                 │       │
│  │                    │                     │                 │       │
│  │                    │  INSERT INTO:       │                 │       │
│  │                    │  - website_messages │                 │       │
│  │                    │  - activities ✅     │                 │       │
│  │                    └─────────────────────┘                 │       │
│  └─────────────────────────────────────────────────────────────┘       │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
               │
               │ (Build isolation)
               ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                         E2B SANDBOX (Optional)                           │
│                                                                           │
│  - Isolated Node.js container                                           │
│  - Vite build + screenshot                                               │
│  - QA validation                                                         │
│  - Timeout: 60s                                                          │
│                                                                           │
│  Quota: 0/3 usado (não configurado em prod)                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. FLUXO DE DADOS — CRIAÇÃO DE SITE

### 2.1 Sequência Completa

```
USER                 NEXT.JS             SUPABASE           WORKER              IA PROVIDER
 │                     │                    │                 │                      │
 │  "Crie um site"     │                    │                 │                      │
 ├────────────────────►│                    │                 │                      │
 │                     │                    │                 │                      │
 │                     │ INSERT run         │                 │                      │
 │                     ├───────────────────►│                 │                      │
 │                     │                    │                 │                      │
 │                     │ Enqueue job        │                 │                      │
 │                     │ (BullMQ)           │                 │                      │
 │                     ├────────────────────┼────────────────►│                      │
 │                     │                    │                 │                      │
 │  { run_id }         │                    │                 │                      │
 │◄────────────────────┤                    │                 │                      │
 │                     │                    │                 │                      │
 │  SSE /activities    │                    │                 │                      │
 ├────────────────────►│                    │                 │                      │
 │  (keep-alive)       │                    │                 │                      │
 │                     │                    │                 │                      │
 │                     │                    │   Claim run     │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │                     │                    │   Load context  │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │                     │                    │                 │  Chat request        │
 │                     │                    │                 ├─────────────────────►│
 │                     │                    │                 │  (system + user)     │
 │                     │                    │                 │                      │
 │                     │                    │                 │  Response + tools    │
 │                     │                    │                 │◄─────────────────────┤
 │                     │                    │                 │                      │
 │                     │                    │   INSERT event  │                      │
 │                     │                    │   (thinking)    │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │  SSE: thinking      │  Realtime trigger  │                 │                      │
 │◄────────────────────┼────────────────────┤                 │                      │
 │                     │                    │                 │                      │
 │                     │                    │   Execute tool: │                      │
 │                     │                    │   create Header │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │                     │                    │   INSERT activity│                     │
 │                     │                    │   (file_create) │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │  SSE: file_create   │  Realtime trigger  │                 │                      │
 │◄────────────────────┼────────────────────┤                 │                      │
 │                     │                    │                 │                      │
 │  GET /files?run_id  │                    │                 │                      │
 ├────────────────────►│                    │                 │                      │
 │                     │                    │                 │                      │
 │                     │   SELECT checkpoint│                 │                      │
 │                     ├───────────────────►│                 │                      │
 │                     │                    │                 │                      │
 │  { files: {...} }   │                    │                 │                      │
 │◄────────────────────┤                    │                 │                      │
 │                     │                    │                 │                      │
 │  [UI atualiza]      │                    │                 │                      │
 │  <500ms latência    │                    │                 │                      │
 │                     │                    │                 │                      │
 │                     │                    │   Execute tool: │                      │
 │                     │                    │   create Hero   │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │  SSE: file_create   │  Realtime trigger  │                 │                      │
 │◄────────────────────┼────────────────────┤                 │                      │
 │                     │                    │                 │                      │
 │  GET /files?run_id  │                    │                 │                      │
 ├────────────────────►│                    │                 │                      │
 │                     │                    │                 │                      │
 │  { files: {...} }   │                    │                 │                      │
 │◄────────────────────┤                    │                 │                      │
 │                     │                    │                 │                      │
 │  [UI atualiza]      │                    │                 │                      │
 │  <500ms latência    │                    │                 │                      │
 │                     │                    │                 │                      │
 │                     │                    │   Build & QA    │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │  SSE: validation    │  Realtime trigger  │                 │                      │
 │◄────────────────────┼────────────────────┤                 │                      │
 │                     │                    │                 │                      │
 │                     │                    │   Save revision │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │                     │                    │   Complete run  │                      │
 │                     │                    │◄────────────────┤                      │
 │                     │                    │                 │                      │
 │  SSE: completed     │  Realtime trigger  │                 │                      │
 │◄────────────────────┼────────────────────┤                 │                      │
 │                     │                    │                 │                      │
 │  [Close SSE]        │                    │                 │                      │
 │                     │                    │                 │                      │
```

**Métricas:**
- Total: ~30-60s para site completo (3-5 arquivos)
- Latência por arquivo: <500ms (SSE → GET → render)
- Throughput: ~6-10 arquivos/minuto

---

## 3. ANATOMIA DE UM EVENTO SSE

### 3.1 Formato Server-Sent Events

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"id":"evt_001","type":"file_create","message":"create: src/Header.tsx","status":"completed","details":{"tool":"create","path":"src/Header.tsx","result":{"saved":"src/Header.tsx"}},"timestamp":1696800000000}

data: {"id":"evt_002","type":"file_write","message":"write: src/App.tsx","status":"completed","details":{"tool":"write","path":"src/App.tsx","result":{"saved":"src/App.tsx"}},"timestamp":1696800001500}

data: {"id":"evt_003","type":"thinking","message":"Vou adicionar responsividade mobile...","details":{"content":"Preciso usar Tailwind breakpoints..."},"timestamp":1696800003000}
```

### 3.2 Estrutura de Activity

```typescript
interface ActivityEvent {
  id: string;                    // UUID gerado pelo DB
  run_id: string;                // FK para website_runs
  type: string;                  // "file_create", "file_write", etc
  message: string;               // Human-readable summary
  status: "started" | "completed" | "error" | null;
  details: Record<string, unknown>; // Payload completo (JSON)
  duration_ms: number | null;    // Tempo de execução
  created_at: string;            // ISO timestamp
}
```

### 3.3 Tipos de Eventos Padronizados

| Tipo | Quando emitir | Details obrigatórios |
|------|---------------|---------------------|
| `thinking` | Antes de tool call | `{ content: string }` |
| `file_create` | Após create bem-sucedido | `{ path: string, tool: "create" }` |
| `file_write` | Após write bem-sucedido | `{ path: string, tool: "write" }` |
| `file_patch` | Após patch bem-sucedido | `{ path: string, tool: "patch", old: string, new: string }` |
| `file_delete` | Após delete bem-sucedido | `{ path: string, tool: "delete" }` |
| `checkpoint_saved` | Após saveRunCheckpoint() | `{ version: string, filesCount: number }` |
| `validation_started` | Início de build/QA | `{ type: "build" | "qa" }` |
| `validation_passed` | Build/QA passou | `{ type: "build" | "qa", duration: number }` |
| `validation_failed` | Build/QA falhou | `{ type: "build" | "qa", errors: string[] }` |
| `usage_recorded` | Após consumo de tokens | `{ model: string, usage: AiUsage }` |

---

## 4. MODELO DE DADOS (Simplificado)

```sql
-- Core tables

CREATE TABLE website_projects (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,  -- RLS: user.id
  name TEXT NOT NULL,
  status TEXT NOT NULL,     -- "draft" | "published" | "archived"
  current_revision_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE website_runs (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  kind TEXT NOT NULL,        -- "create" | "edit" | "build"
  status TEXT NOT NULL,      -- "queued" | "editing" | "completed" | "failed"
  prompt TEXT,
  checkpoint JSONB,          -- { files, budgetConsumed, progress, ... }
  base_revision_id UUID,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project_id) REFERENCES website_projects(id)
);

CREATE TABLE website_messages (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  run_id UUID NOT NULL,
  role TEXT NOT NULL,        -- "user" | "assistant" | "system" | "tool"
  content TEXT NOT NULL,     -- JSON string ou texto plain
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (run_id) REFERENCES website_runs(id)
);

CREATE TABLE website_run_activities (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  type TEXT NOT NULL,        -- "file_create", "thinking", etc
  message TEXT NOT NULL,
  status TEXT,               -- "started" | "completed" | "error"
  details JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (run_id) REFERENCES website_runs(id)
);

CREATE TABLE website_revisions (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  files JSONB NOT NULL,      -- { "src/App.tsx": "content", ... }
  message TEXT,
  parent_id UUID,
  actor_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project_id) REFERENCES website_projects(id)
);

CREATE TABLE website_builds (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL,
  revision_id UUID NOT NULL,
  status TEXT NOT NULL,      -- "ready" | "failed"
  success BOOLEAN,
  qa JSONB,                  -- { passed, visual_review, design_direction, ... }
  screenshots JSONB,         -- { desktop: base64, mobile: base64 }
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance

CREATE INDEX idx_activities_run_created 
  ON website_run_activities(run_id, created_at DESC);

CREATE INDEX idx_messages_project_created 
  ON website_messages(project_id, created_at DESC);

CREATE INDEX idx_runs_project_status 
  ON website_runs(project_id, status, created_at DESC);

-- RLS policies (example)

ALTER TABLE website_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own projects"
  ON website_projects FOR SELECT
  USING (client_id = auth.uid());

CREATE POLICY "Users update own projects"
  ON website_projects FOR UPDATE
  USING (client_id = auth.uid());
```

---

## 5. CHECKPOINT STRUCTURE

### 5.1 Formato Completo

```typescript
interface WebsiteRunCheckpoint {
  // Arquivos (estado atual do workspace)
  files: WebsiteFiles;  // { "src/App.tsx": "content", ... }
  
  // Request pendente (se interrompido)
  request?: string;
  
  // Notas internas do agente
  notes?: string;
  
  // Orçamento consumido
  budgetConsumed: {
    turns: number;
    tools: number;
    outputTokens: number;
    totalTokens: number;
    corrections: number;
  };
  
  // Assets referenciados
  assetIds: string[];
  
  // Design direction privada
  designDirection?: {
    mode: "persuade" | "operate" | "read" | "experience";
    palette: string;
    typography: string;
    layout: string;
    imagery: string;
    tone: string;
  };
  
  // Progresso estruturado
  progress?: {
    status: "editing" | "validating" | "blocked";
    changedPaths: string[];     // Últimos 100 arquivos alterados
    diagnostics: string[];      // Últimos 8 diagnósticos (2000 chars cada)
    nextAction: string;         // Próxima ação planejada (1000 chars)
  };
  
  // QA report (se já validou)
  qaReport?: {
    passed: boolean;
    issues: string[];
    summary: string;
    checks?: Array<{
      dimension: string;
      passed: boolean;
      evidence: string;
    }>;
  };
}
```

### 5.2 Serialização

```typescript
// Save
const serialized = JSON.stringify(checkpoint);
const compressed = gzip(serialized);  // Opcional, se >100KB

await db.from("website_runs")
  .update({ 
    checkpoint: checkpoint,  // Supabase suporta JSONB direto
    updated_at: new Date().toISOString()
  })
  .eq("id", run.id);

// Load
const { data } = await db.from("website_runs")
  .select("checkpoint")
  .eq("id", run.id)
  .single();

const checkpoint: WebsiteRunCheckpoint = data.checkpoint;
```

### 5.3 Limites

- **Tamanho máximo:** 10 MB por checkpoint (limite PostgreSQL JSONB)
- **Files:** Se >10MB, mover para `website_revisions` e referenciar
- **Compressão:** Ativar se checkpoint >1MB
- **Versionamento:** ETag baseado em hash SHA-256 dos files

---

## 6. SEGURANÇA E PERMISSÕES

### 6.1 Row Level Security (RLS)

```sql
-- Todas as tabelas filtram por client_id = auth.uid()

-- Projects: user vê apenas os próprios
CREATE POLICY "projects_select" ON website_projects
  FOR SELECT USING (client_id = auth.uid());

-- Runs: user cria apenas para próprios projects
CREATE POLICY "runs_insert" ON website_runs
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM website_projects
      WHERE id = project_id AND client_id = auth.uid()
    )
  );

-- Activities: user vê apenas de próprias runs
CREATE POLICY "activities_select" ON website_run_activities
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM website_runs r
      JOIN website_projects p ON p.id = r.project_id
      WHERE r.id = run_id AND p.client_id = auth.uid()
    )
  );
```

### 6.2 API Route Protection

```typescript
// src/lib/sites/server.ts

export async function requireSitesContext(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  
  if (error || !user) {
    return { 
      ok: false, 
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    };
  }
  
  return {
    ok: true,
    clientId: user.id,
    db: supabase
  };
}
```

### 6.3 Worker Isolation

```typescript
// Worker NUNCA acessa runs de outro tenant

async function claimRun(db: SupabaseClient, workerId: string) {
  const { data } = await db.from("website_runs")
    .update({ 
      worker_id: workerId,
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      status: "editing"
    })
    .eq("status", "queued")
    .is("worker_id", null)
    // ✅ RLS garante que só vê runs de projetos do próprio tenant
    .limit(1)
    .select("*")
    .single();
  
  return data;
}
```

---

## 7. ESCALABILIDADE E PERFORMANCE

### 7.1 Bottlenecks Identificados

| Componente | Limite atual | Solução |
|------------|--------------|---------|
| SSE connections | ~100 simultâneas por instância | Load balancer + sticky sessions |
| Checkpoint size | 10 MB (JSONB) | Mover files grandes para blob storage |
| DB queries | 1000 QPS | Connection pooling + read replicas |
| Worker concurrency | 3 jobs simultâneos | Escalar horizontalmente (mais workers) |
| Realtime channels | 100 por cliente | Multiplexar: 1 channel por run_id |

### 7.2 Otimizações Implementadas

- ✅ **Checkpoint incremental:** Salvar apenas após tools que mudam arquivos
- ✅ **Message compaction:** Histórico de chat reduzido para últimas 8 mensagens
- ✅ **Activity TTL:** Limpar activities >30 dias (cron job)
- ✅ **Token reservation:** Reserve antes de chamar IA, evita race conditions
- ✅ **Lease mechanism:** Worker renova lease a cada 30s, timeout 2min

### 7.3 Próximas Otimizações

- 🔲 **Checkpoint diff:** Salvar apenas delta em vez de snapshot completo
- 🔲 **CDN para assets:** Mover images/screenshots para Cloudflare R2
- 🔲 **Redis cache:** Cache de checkpoints ativos (últimos 5 min)
- 🔲 **WebSocket:** Substituir SSE por WS bidirecional (menos overhead)
- 🔲 **Edge Functions:** Mover validação simples para Supabase Edge

---

## 8. MONITORAMENTO E OBSERVABILIDADE

### 8.1 Métricas Chave (KPIs)

| Métrica | Target | Medição |
|---------|--------|---------|
| Latência SSE | <100ms P95 | `timestamp_received - timestamp_sent` |
| Latência checkpoint fetch | <200ms P95 | Time to `/files?run_id` response |
| Taxa de sucesso de runs | >95% | `completed / (completed + failed)` |
| Uptime worker | >99.5% | Heartbeat a cada 30s |
| Taxa de timeout | <1% | Runs que excedem 15min |
| Uso de quota | <80% | `consumed / limit` para builds, tokens |

### 8.2 Logs Estruturados

```typescript
// Worker
console.log(JSON.stringify({
  level: "info",
  component: "worker",
  event: "tool_executed",
  run_id: run.id,
  tool: "write",
  path: "src/App.tsx",
  duration_ms: 45,
  timestamp: Date.now()
}));

// UI
console.log(JSON.stringify({
  level: "info",
  component: "ui",
  event: "sse_received",
  run_id: runId,
  type: "file_write",
  latency_ms: Date.now() - event.timestamp,
  timestamp: Date.now()
}));
```

### 8.3 Alertas

- 🚨 **Critical:** Worker down >5min
- ⚠️ **Warning:** Taxa de falha >10% em 1h
- 📊 **Info:** Quota >90% consumida

---

## RESUMO TÉCNICO

**Stack:**
- Frontend: Next.js 16 (App Router) + React 19 + TypeScript 5
- Backend: Supabase (PostgreSQL + Realtime + RLS)
- Queue: BullMQ (Redis opcional, graceful degradation)
- IA: OpenRouter, Gemini, NVIDIA (multi-provider)
- Build: E2B Sandbox (opcional, quota 0/3)

**Arquitetura:**
- Multi-tenant com RLS
- Worker isolado via BullMQ
- SSE para eventos em tempo real
- Checkpoint incremental para continuidade
- Preview iframe isolado (shadow DOM + iframe)

**Performance:**
- Latência SSE: <100ms
- Latência total (SSE → render): <500ms
- Throughput: 6-10 arquivos/minuto
- Checkpoint: 10 MB max, <1s para salvar

**Segurança:**
- RLS em todas as tabelas
- JWT auth via Supabase
- Worker never acessa cross-tenant
- Preview isolado (origin diferente)

**Testes:**
- 1607 unit tests (84% coverage)
- 36 browser tests (Playwright)
- TypeScript strict mode
- ESLint + Prettier

**Próximos passos:**
1. Implementar correção de arquivos em tempo real (2-3h)
2. Adicionar observabilidade completa (4-6h)
3. Protocolo de continuidade entre modelos (2-3h)
4. Otimizações de performance (4-8h)
