# 📚 Documentação Completa do Site Studio

## 🎯 Visão Geral

O **Site Studio** é um sistema avançado de geração automatizada de sites usando IA, integrado ao painel SDR. Ele permite que usuários criem, editem e publiquem sites profissionais através de conversas naturais com agentes de IA especializados.

---

## 🏗️ Arquitetura do Sistema

### Componentes Principais

```
┌─────────────────────────────────────────────────────────────┐
│                      CAMADA DE INTERFACE                     │
│  • /sites (listagem de projetos)                            │
│  • /sites/[id] (editor interativo)                          │
│  • /sites/[id]/preview (visualização isolada)               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     CAMADA DE NEGÓCIO                        │
│  • API Routes (/api/sites/*)                                │
│  • Agent Runtime (processamento IA)                         │
│  • Tools System (manipulação de arquivos)                   │
│  • Validation & QA (build e testes)                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   CAMADA DE INFRAESTRUTURA                   │
│  • Supabase (banco de dados)                                │
│  • E2B (sandbox isolado)                                    │
│  • Cloudflare Pages (deploy)                                │
│  • OpenRouter (modelos de IA)                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 📁 Estrutura de Arquivos

### Diretório Principal: `src/lib/sites/`

```
src/lib/sites/
├── agent.ts              # Runtime principal do agente
├── agent-context.ts      # Contexto e configuração do agente
├── tools.ts              # Ferramentas disponíveis para o agente
├── prompts.ts            # Sistema de prompts e instruções
├── impeccable.ts         # Sistema de design Impeccable
├── validation.ts         # Validação de arquivos e conteúdo
├── worker.ts             # Worker para processamento assíncrono
├── run-checkpoint.ts     # Sistema de checkpoints
├── skills.ts             # Sistema de skills customizadas
├── types.ts              # Definições TypeScript
├── ui-helpers.ts         # Utilitários de UI
└── __tests__/            # Suíte de testes
```

---

## 🔄 Fluxo de Trabalho Completo

### 1. Criação de Projeto

```typescript
// Usuario cria um novo site
POST /api/sites

Body: {
  name: string,              // Nome do site
  client_context: {          // Contexto do cliente
    name: string,
    segment: string,
    phone?: string,
    whatsapp?: string,
    website?: string,
    city?: string,
    address?: string,
    description?: string,
    services?: string,
    notes?: string
  },
  instructions: string,      // Instruções específicas
  model_mode: "auto" | "quality" | "economy" | "manual",
  cta: {                     // Call-to-action
    type: "whatsapp" | "form" | "phone" | "calendar" | "url",
    value: string
  }
}

Response: {
  project: WebsiteProject
}
```

### 2. Execução do Agente

```typescript
// Usuário envia mensagem para o agente
POST /api/sites/[id]/chat

Body: {
  message: string,           // Mensagem do usuário
  asset_ids?: string[],      // IDs de assets (logos, imagens)
  model_id?: string          // Modelo específico (opcional)
}

// Sistema cria um RUN
{
  id: string,
  status: "queued" | "planning" | "editing" | "validating" | "completed" | "failed",
  prompt: string,
  base_revision_id: string,
  asset_ids: string[]
}
```

### 3. Processamento pelo Worker

```typescript
// O worker processa o run em background
const runtime = new WebsiteAgentRuntime({
  chat: chatFunction,        // Chamada ao modelo de IA
  load: loadContext,         // Carrega contexto do projeto
  check: checkAbort,         // Verifica cancelamento
  status: updateStatus,      // Atualiza status
  event: logEvent,           // Registra eventos
  usage: recordUsage,        // Registra uso de tokens
  checkpoint: saveProgress,  // Salva progresso
  reserveTokens: reserve     // Reserva tokens
});

await runtime.run(run, abortSignal);
```

### 4. Manipulação de Arquivos (Tools)

O agente utiliza ferramentas para manipular os arquivos do site:

```typescript
const tools = new WebsiteTools(files, {
  context: projectContext,
  assets: selectedAssets,
  patchOnly: isSimpleEdit,        // true para edições pontuais
  impeccable: hasImpeccableSkill, // true se skill Impeccable ativa
  requireDesignDirection: needsDesignFirst,
  designDirection: currentDesign
});

// Ferramentas disponíveis:
await tools.execute("list", {});                    // Lista arquivos
await tools.execute("read", { path, start_line, end_line });
await tools.execute("create", { path, content });   // Cria arquivo
await tools.execute("write", { path, content });    // Substitui arquivo
await tools.execute("patch", { path, old, new });   // Patch cirúrgico
await tools.execute("delete", { path });            // Deleta arquivo
await tools.execute("search", { query, path? });    // Busca texto
await tools.execute("checkpoint", { name });        // Salva checkpoint
await tools.execute("restore", { name });           // Restaura checkpoint
await tools.execute("run_validation", {});          // Valida código
```

### 5. Validação e Build

```typescript
// Validação estática (sempre executada)
const staticValidation = validateWebsiteContent(files);
// Retorna: { passed: boolean, errors, warnings, info }

// Build e QA visual (executado em sandbox E2B)
const buildResult = await buildWebsite(files, {
  timeout: 120000,
  format: "png",
  viewports: { desktop: { width: 1440, height: 900 } }
});

// Resultado:
{
  success: boolean,
  screenshots?: { desktop: string },  // Base64 PNG
  qa: {
    static_validation: { passed, errors, warnings },
    build_status: "success" | "failed",
    visual_check: "captured" | "skipped",
    failure_kind?: "source" | "infrastructure"
  },
  artifact?: Uint8Array,  // Build completo (ZIP)
  logs: string[]
}
```

### 6. Criação de Revisão

```typescript
// Após sucesso, cria nova revisão
POST /api/sites/[id]/revisions

Body: {
  files: WebsiteFiles,
  message: string,
  parent_id?: string
}

Response: {
  revision: {
    id: string,
    files: WebsiteFiles,
    hash: string,
    created_at: string,
    actor_id: string
  }
}
```

### 7. Deploy (Publicação)

```typescript
// Publica revisão no Cloudflare Pages
POST /api/sites/[id]/deploy

Body: {
  revision_id: string
}

// Sistema:
// 1. Valida revisão
// 2. Faz build completo
// 3. Envia para Cloudflare Pages
// 4. Atualiza projeto com URL pública

Response: {
  deployment: {
    id: string,
    url: string,
    status: "success" | "failed"
  }
}
```

---

## 🛠️ Ferramentas do Agente (Detalhado)

### Ferramentas de Leitura

#### `list`
```typescript
// Lista todos os arquivos do workspace
await tools.execute("list", {});

// Retorna:
["index.html", "src/App.tsx", "src/tokens.css", ...]
```

#### `read`
```typescript
// Leitura por linhas (preferencial)
await tools.execute("read", {
  path: "src/App.tsx",
  start_line: 10,
  end_line: 50
});

// Leitura por caracteres (quando necessário)
await tools.execute("read", {
  path: "src/tokens.css",
  offset: 0,
  limit: 5000
});

// Retorna:
{
  content: string,           // Conteúdo com números de linha
  start_line: number,
  end_line: number,
  total_lines: number,
  next_line: number | null   // Para paginação
}
```

#### `read_files`
```typescript
// Lê múltiplos arquivos de uma vez
await tools.execute("read_files", {
  paths: ["src/App.tsx", "src/tokens.css", "src/styles.css"]
});

// Retorna: Record<string, string>
```

#### `search`
```typescript
// Busca texto em todos os arquivos
await tools.execute("search", {
  query: "background-color",
  path: "src/styles.css"  // Opcional: restringe a um arquivo
});

// Retorna:
[
  { path: "src/styles.css", line: 45, text: "background-color: #000;" },
  { path: "src/tokens.css", line: 12, text: "  --bg: #000;" }
]
```

### Ferramentas de Escrita

#### `create`
```typescript
// Cria novo arquivo (não pode existir)
await tools.execute("create", {
  path: "src/components/Button.tsx",
  content: "export function Button() { ... }"
});
```

#### `write`
```typescript
// Substitui arquivo existente completamente
await tools.execute("write", {
  path: "src/App.tsx",
  content: "... novo conteúdo completo ..."
});
```

#### `patch` ⭐ (Preferencial para edições pontuais)
```typescript
// Substitui trecho específico de forma cirúrgica
await tools.execute("patch", {
  path: "src/tokens.css",
  old: "  --color-primary: #000;",
  new: "  --color-primary: #3B82F6;"
});

// Regras:
// - 'old' deve aparecer EXATAMENTE UMA VEZ no arquivo
// - Inclua 1 linha de contexto se necessário para unicidade
// - Economiza tokens (não precisa do arquivo completo)
```

#### `delete`
```typescript
// Remove arquivo do workspace
await tools.execute("delete", {
  path: "src/unused.tsx"
});
```

#### `rename`
```typescript
// Renomeia arquivo (destino não pode existir)
await tools.execute("rename", {
  path: "src/OldName.tsx",
  to: "src/NewName.tsx"
});
```

### Ferramentas de Contexto

#### `get_context`
```typescript
// Retorna contexto confirmado do projeto
await tools.execute("get_context", {});

// Retorna:
{
  name: string,              // Nome do site
  client: {                  // Dados confirmados do cliente
    name, segment, phone, whatsapp, website,
    city, address, description, services, notes
  },
  cta: { type, value }       // Call-to-action configurado
}
```

#### `assets`
```typescript
// Lista assets disponíveis
await tools.execute("assets", {});

// Retorna:
[
  {
    id: string,
    name: string,
    mime: string,
    purpose: "logo" | "content" | "reference",
    width: number | null,
    height: number | null,
    public_path: string | null  // Caminho público para usar no site
  }
]
```

### Ferramentas de Gestão

#### `checkpoint`
```typescript
// Salva estado atual com nome
await tools.execute("checkpoint", {
  name: "before-redesign"
});

// Limite: 6 checkpoints por run
// Nome 'initial' é reservado (criado automaticamente)
```

#### `restore`
```typescript
// Restaura checkpoint salvo
await tools.execute("restore", {
  name: "before-redesign"
});

// ou restaura estado inicial:
await tools.execute("restore", {
  name: "initial"
});
```

#### `run_validation`
```typescript
// Valida workspace estaticamente
await tools.execute("run_validation", {});

// Retorna:
{
  passed: boolean,
  errors: string[],
  warnings: string[],
  info: string[],
  scope: "static",
  build: "pending",
  visual: "pending"
}
```

### Ferramentas Impeccable (quando skill ativa)

#### `read_design_reference`
```typescript
// Lê referências oficiais do Impeccable Design
await tools.execute("read_design_reference", {
  name: "typography",
  offset: 0,
  limit: 12000
});

// Referências disponíveis:
// - typography
// - color
// - spacing
// - layout
// - components
// - accessibility
```

#### `record_design_direction`
```typescript
// Registra direção de design antes de construir
await tools.execute("record_design_direction", {
  mode: "persuade" | "operate" | "read" | "experience",
  palette: "Descrição da paleta...",
  typography: "Descrição da tipografia...",
  layout: "Descrição do layout...",
  components: "Descrição dos componentes...",
  motion: "Descrição das animações...",
  voice: "Tom e estilo de escrita..."
});

// Obrigatório quando:
// - Skill Impeccable ativa
// - Site novo OU redesign explícito
// - Não é build de validação
```

---

## 🎨 Sistema Impeccable Design

### Conceito

O **Impeccable Design** é um sistema de design anti-template que garante qualidade visual profissional, evitando sites genéricos.

### Ativação

```typescript
// Skill ativa automaticamente quando tags no contexto:
const tags = [
  "design", "visual", "identidade", "marca", "branding",
  "layout", "tipografia", "cores", "estilo", "moderna",
  "elegante", "profissional", "diferenciado"
];

// ou manualmente selecionada pelo usuário
```

### Fluxo Impeccable

```
1. USER: "Crie um site moderno para minha clínica"
   ↓
2. AGENT: Lê referências oficiais via read_design_reference()
   ↓
3. AGENT: Registra direção específica via record_design_direction()
   ↓
4. AGENT: Constrói site seguindo direção registrada
   ↓
5. SYSTEM: Valida que a direção foi respeitada
   ↓
6. OUTPUT: Site com identidade visual única e profissional
```

### Validações Impeccable

- **Paleta**: Escala tonal de 5-7 níveis, não flat white/dark
- **Tipografia**: Escala fluida com clamp(), families em custom properties
- **Layout**: Grid-first, geometria arredondada, tokens centralizados
- **Componentes**: Design system tokenizado, ritmo consistente
- **Acessibilidade**: Contraste WCAG AA, estados interativos claros

---

## ⚙️ Sistema de Orçamento (Budget)

### Budget para Agente Normal

```typescript
const WEBSITE_AGENT_BUDGET = {
  turns: 12,              // Máximo 12 rodadas de conversa
  outputTokens: 80_000,   // Máximo 80k tokens de saída
  totalTokens: 800_000,   // Máximo 800k tokens total
  qaOutputTokens: 12_000, // Tokens reservados para QA
  qaReserve: 100_000,     // Reserva total para QA
  qaTurns: 3,             // Máximo 3 rodadas de QA
  corrections: 2          // Máximo 2 tentativas de correção
};
```

### Budget para Edição Cirúrgica (Patch Only)

```typescript
const WEBSITE_EDIT_BUDGET = {
  turns: 3,               // Máximo 3 rodadas
  outputTokens: 8_000,    // Máximo 8k tokens de saída
  totalTokens: 60_000,    // Máximo 60k tokens total
  qaOutputTokens: 4_000,  // Tokens reservados para QA
  qaReserve: 20_000,      // Reserva para QA
  qaTurns: 2,             // Máximo 2 rodadas de QA
  corrections: 1          // Máximo 1 tentativa de correção
};
```

### Modo Patch Only (Ativado Automaticamente)

```typescript
// Ativado quando TODAS as condições são verdadeiras:
const patchOnly = 
  run.kind !== "build" &&                    // Não é build
  isEstablishedWebsite(files) &&             // Site já existe
  isSimpleWebsiteRequest(prompt) &&          // Pedido simples
  !pendingRequest &&                         // Não tem trabalho pendente
  !isContinueRequest(prompt);                // Não é "continue"

// Exemplos de pedidos simples:
// ✅ "Mude a cor do botão para azul"
// ✅ "Troque o telefone para (11) 98765-4321"
// ✅ "Aumente o tamanho da fonte do título"
// ✅ "Corrija o erro de ortografia no rodapé"

// Exemplos que NÃO ativam patch only:
// ❌ "Crie uma nova página de serviços"
// ❌ "Refaça o layout do site"
// ❌ "Adicione integração com pagamento"
// ❌ "Continue o trabalho anterior"
```

### Ferramentas Bloqueadas em Patch Only

Quando `patchOnly = true`, estas ferramentas são bloqueadas:
- `create` (criar arquivo)
- `write` (substituir arquivo completo)
- `delete` (deletar arquivo)
- `rename` (renomear arquivo)
- `restore` (restaurar checkpoint)
- `record_design_direction` (registrar direção)

**Apenas permitido**: `read`, `read_files`, `search`, `patch`, `list`, `get_context`, `assets`, `checkpoint`, `run_validation`

---

## 🔐 Sistema de Segurança

### Prompt de Segurança (Sempre Incluído)

```typescript
const WEBSITE_SECURITY_PROMPT = `
REGRAS IMUTÁVEIS DO SITE STUDIO

1. Trabalhe somente no workspace virtual e nas ferramentas disponíveis
   - Não execute shell, código no servidor, consultas SQL
   - Não altere package.json, dependências ou configurações fixas

2. Nunca solicite, exponha ou incorpore credenciais ou dados sensíveis
   - Validação e autorização são impostas pelo servidor

3. Use apenas assets selecionados deste projeto
   - Preserve logos e arquivos originais
   - Use caminhos locais de publicação fornecidos pelas ferramentas

4. Não invente provas sociais, depoimentos, credenciais ou preços

5. Produza React, Vite, TypeScript e CSS dentro dos arquivos permitidos
   - Centralize design tokens em src/tokens.css
   - Não use scripts remotos, eval, rastreadores, iframes arbitrários

6. Após concluir, forneça resumo em texto sem chamadas adicionais
`;
```

### Validações de Origem

```typescript
// Todas as rotas API validam origem:
function assertWebsiteOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || 
      origin !== new URL(request.url).origin || 
      request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Origem não autorizada");
  }
}
```

### Limitações de Tamanho

```typescript
const WEBSITE_LIMITS = {
  files: 50,                    // Máximo 50 arquivos
  fileBytes: 200_000,           // Máximo 200KB por arquivo
  totalBytes: 3_000_000,        // Máximo 3MB total
  toolResultBytes: 100_000,     // Máximo 100KB por resultado de tool
  pathLength: 200,              // Máximo 200 caracteres no path
  editablePaths: [              // Apenas estes arquivos editáveis
    "index.html",
    "src/App.tsx",
    "src/tokens.css",
    "src/styles.css",
    // + componentes em src/components/*.tsx
  ]
};
```

---

## 📊 Banco de Dados (Supabase)

### Tabelas Principais

#### `website_projects`
```sql
CREATE TABLE website_projects (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  client_context JSONB,
  instructions TEXT,
  model_mode TEXT DEFAULT 'auto',
  model_id TEXT,
  selected_skill_ids TEXT[] DEFAULT '{}',
  cta JSONB,
  status TEXT DEFAULT 'draft',
  current_revision_id UUID,
  published_deployment_id UUID,
  published_url TEXT,
  last_published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

#### `website_revisions`
```sql
CREATE TABLE website_revisions (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES website_revisions(id),
  message TEXT NOT NULL,
  files JSONB NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  actor_id UUID NOT NULL
);
```

#### `website_runs`
```sql
CREATE TABLE website_runs (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'agent',
  status TEXT DEFAULT 'queued',
  prompt TEXT NOT NULL,
  model_id TEXT,
  base_revision_id UUID REFERENCES website_revisions(id),
  asset_ids TEXT[] DEFAULT '{}',
  error TEXT,
  cancel_requested BOOLEAN DEFAULT FALSE,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `website_messages`
```sql
CREATE TABLE website_messages (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  run_id UUID REFERENCES website_runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `website_assets`
```sql
CREATE TABLE website_assets (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  purpose TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `website_builds`
```sql
CREATE TABLE website_builds (
  id UUID PRIMARY KEY,
  revision_id UUID NOT NULL REFERENCES website_revisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  artifact BYTEA,
  screenshots JSONB,
  logs TEXT,
  qa_report JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `website_deployments`
```sql
CREATE TABLE website_deployments (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES website_projects(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES website_revisions(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  deployed_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 🚀 APIs Disponíveis

### Projetos

```typescript
// Listar projetos
GET /api/sites
Response: { projects: WebsiteProject[] }

// Criar projeto
POST /api/sites
Body: { name, client_context, instructions, model_mode, cta }
Response: { project: WebsiteProject }

// Obter projeto
GET /api/sites/[id]
Response: { project: WebsiteProject }

// Atualizar projeto
PATCH /api/sites/[id]
Body: Partial<WebsiteProject>
Response: { project: WebsiteProject }

// Deletar projeto
DELETE /api/sites/[id]
Response: { success: true }
```

### Chat (Interação com Agente)

```typescript
// Enviar mensagem
POST /api/sites/[id]/chat
Body: { message, asset_ids?, model_id? }
Response: { run_id: string, status: string }

// Obter histórico
GET /api/sites/[id]/messages
Response: { messages: WebsiteMessage[] }

// Cancelar run
POST /api/sites/[id]/runs/[run_id]/cancel
Response: { success: true }
```

### Revisões

```typescript
// Listar revisões
GET /api/sites/[id]/revisions
Response: { revisions: WebsiteRevision[] }

// Criar revisão manualmente
POST /api/sites/[id]/revisions
Body: { files, message, parent_id? }
Response: { revision: WebsiteRevision }

// Obter revisão
GET /api/sites/[id]/revisions/[revision_id]
Response: { revision: WebsiteRevision }
```

### Builds

```typescript
// Listar builds
GET /api/sites/[id]/builds
Response: { builds: WebsiteBuild[] }

// Disparar build
POST /api/sites/[id]/builds
Body: { revision_id }
Response: { build_id: string, status: string }

// Obter build
GET /api/sites/[id]/builds/[build_id]
Response: { build: WebsiteBuild }

// Download artifact
GET /api/sites/[id]/builds/[build_id]/download
Response: application/zip
```

### Deploy

```typescript
// Deploy para Cloudflare Pages
POST /api/sites/[id]/deploy
Body: { revision_id }
Response: { deployment: WebsiteDeployment }

// Listar deployments
GET /api/sites/[id]/deployments
Response: { deployments: WebsiteDeployment[] }
```

### Assets

```typescript
// Listar assets
GET /api/sites/[id]/assets
Response: { assets: WebsiteAsset[] }

// Upload asset
POST /api/sites/[id]/assets
Body: FormData { file, purpose: "logo" | "content" | "reference" }
Response: { asset: WebsiteAsset }

// Deletar asset
DELETE /api/sites/[id]/assets/[asset_id]
Response: { success: true }
```

### Skills

```typescript
// Listar skills disponíveis
GET /api/sites/skills
Response: { skills: WebsiteSkill[] }

// Criar skill customizada
POST /api/sites/skills
Body: { name, description, instructions, category, tags, trigger_mode }
Response: { skill: WebsiteSkill }

// Atualizar skill
PATCH /api/sites/skills/[skill_id]
Body: Partial<WebsiteSkill>
Response: { skill: WebsiteSkill }

// Deletar skill
DELETE /api/sites/skills/[skill_id]
Response: { success: true }
```

### Configurações

```typescript
// Obter configurações globais
GET /api/sites/settings
Response: { settings: WebsiteSettings }

// Atualizar configurações
PATCH /api/sites/settings
Body: Partial<WebsiteSettings>
Response: { settings: WebsiteSettings }

// Versionar prompt criativo
POST /api/sites/settings/prompts
Body: { prompt: string }
Response: { version: WebsitePromptVersion }

// Listar versões do prompt
GET /api/sites/settings/prompts
Response: { versions: WebsitePromptVersion[] }

// Restaurar versão do prompt
POST /api/sites/settings/prompts/restore
Body: { version_id: string }
Response: { version: WebsitePromptVersion }
```

---

## 🧪 Sistema de Testes

### Localização

```
src/lib/sites/__tests__/
├── agent.test.ts
├── impeccable.test.ts
├── instructions.test.ts
├── tools.test.ts
├── worker.test.ts
└── validation.test.ts
```

### Executar Testes

```bash
# Todos os testes
npm test

# Testes específicos
npm test -- agent.test.ts

# Com coverage
npm test -- --coverage

# Watch mode
npm test -- --watch
```

---

## 🔧 Configuração de Ambiente

### Variáveis Obrigatórias

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# E2B Sandbox (para builds)
E2B_API_KEY=e2b_...
E2B_SITE_TEMPLATE_ID=website-builder-v1

# Cloudflare Pages (para deploys)
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...

# OpenRouter (modelos de IA)
OPENROUTER_API_KEY=sk-or-v1-...

# Aplicação
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### Modelos Recomendados

```typescript
// Para qualidade máxima
const QUALITY_MODELS = [
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3-opus",
  "openai/gpt-4-turbo"
];

// Para economia
const ECONOMY_MODELS = [
  "anthropic/claude-3-haiku",
  "openai/gpt-3.5-turbo",
  "google/gemini-pro"
];

// Com suporte a imagens (vision)
const VISION_MODELS = [
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3-opus",
  "openai/gpt-4-vision-preview"
];
```

---

## 📈 Monitoramento e Logs

### Eventos do Sistema

```typescript
// Eventos registrados automaticamente:
{
  role: "system",
  content: JSON.stringify({
    checkpoint: "initial",
    revision_id: string,
    files: string[]
  })
}

{
  role: "system",
  content: JSON.stringify({
    active_skills: string[]
  })
}

{
  role: "system",
  content: JSON.stringify({
    model_call: {
      model: string,
      status: "started" | "completed" | "failed"
    }
  })
}

{
  role: "system",
  content: JSON.stringify({
    tool: string,
    result: string,
    fast_edit?: boolean
  })
}

{
  role: "system",
  content: JSON.stringify({
    vision_assets: string[]
  })
}

{
  role: "system",
  content: JSON.stringify({
    skill_analysis: {
      skill: string,
      status: string,
      source: string,
      message: string
    }
  })
}
```

### Métricas de Uso

```typescript
interface WebsiteUsage {
  requests: number,          // Total de chamadas ao modelo
  tools: number,             // Total de execuções de tools
  outputTokens: number,      // Tokens de saída acumulados
  totalTokens: number,       // Tokens totais acumulados
  qaRequests: number,        // Chamadas de QA
  qaOutputTokens: number     // Tokens de QA
}
```

---

## 🐛 Troubleshooting

### Problema: Build Falha no E2B

```typescript
// Verificar:
// 1. Template E2B existe e está correto
// 2. API Key válida
// 3. Arquivos não excedem limites
// 4. Sintaxe dos arquivos está correta

// Logs detalhados em:
build.logs  // Array de strings com saída do build
```

### Problema: Deploy Falha no Cloudflare

```typescript
// Verificar:
// 1. Token Cloudflare tem permissões corretas
// 2. Account ID correto
// 3. Build foi bem-sucedido
// 4. Artifact existe e não está corrompido

// Erro detalhado em:
deployment.error  // String com mensagem de erro
```

### Problema: Agente Não Responde

```typescript
// Verificar:
// 1. Run status está "queued" ou "processing"
// 2. Worker está rodando
// 3. Modelo configurado existe
// 4. OpenRouter API Key válida
// 5. Budget não foi excedido

// Cancelar run travado:
POST /api/sites/[id]/runs/[run_id]/cancel
```

### Problema: Patch Only Não Ativa

```typescript
// Condições necessárias:
// 1. Site já existe (tem revisão base)
// 2. Pedido é simples (não é "crie", "refaça", "integre")
// 3. Não tem trabalho pendente
// 4. Não é continuação explícita

// Forçar modo normal:
// Use palavras como "crie", "refaça", "reestruture"
```

---

## 📚 Referências Técnicas

### Stack Tecnológico

- **Framework**: Next.js 14+ (App Router)
- **UI**: React 18+, TypeScript, Tailwind CSS
- **Banco**: Supabase (PostgreSQL + Storage + Auth)
- **IA**: OpenRouter (múltiplos provedores)
- **Build**: E2B (sandbox isolado com Node.js + Vite)
- **Deploy**: Cloudflare Pages
- **State**: React Context + Server State
- **Forms**: React Hook Form + Zod

### Padrões de Código

- **Componentes**: Function components com hooks
- **Tipos**: TypeScript strict mode
- **Estilos**: Tailwind utility-first + tokens CSS
- **API**: Route handlers (App Router)
- **Validação**: Zod schemas
- **Testes**: Jest + Testing Library

---

## 🎓 Exemplos de Uso

### Exemplo 1: Site Simples

```typescript
// 1. Criar projeto
const project = await createProject({
  name: "Clínica Dr. Silva",
  client_context: {
    name: "Dr. João Silva",
    segment: "Saúde - Odontologia",
    phone: "(11) 98765-4321",
    whatsapp: "5511987654321",
    city: "São Paulo",
    description: "Clínica odontológica especializada em implantes",
    services: "Implantes, Ortodontia, Clareamento"
  },
  instructions: "Site profissional e clean, com foco em credibilidade",
  model_mode: "quality",
  cta: {
    type: "whatsapp",
    value: "5511987654321"
  }
});

// 2. Enviar primeira mensagem
await sendMessage(project.id, {
  message: "Crie um site moderno para a clínica, com seções: home, serviços, sobre e contato"
});

// 3. Aguardar conclusão e publicar
const revision = await waitForCompletion(project.id);
await deploy(project.id, revision.id);
```

### Exemplo 2: Edição Pontual

```typescript
// Trocar cor (ativa patch only automaticamente)
await sendMessage(project.id, {
  message: "Mude a cor primária para azul (#3B82F6)"
});

// Trocar telefone
await sendMessage(project.id, {
  message: "Atualize o telefone para (11) 99999-8888"
});

// Ajustar texto
await sendMessage(project.id, {
  message: "No título principal, troque 'Bem-vindo' por 'Boas-vindas'"
});
```

### Exemplo 3: Com Assets

```typescript
// 1. Upload de logo
const logo = await uploadAsset(project.id, logoFile, "logo");

// 2. Enviar mensagem com asset
await sendMessage(project.id, {
  message: "Adicione o logo no cabeçalho do site",
  asset_ids: [logo.id]
});

// 3. Upload de imagens de conteúdo
const image1 = await uploadAsset(project.id, image1File, "content");
const image2 = await uploadAsset(project.id, image2File, "content");

// 4. Usar nas seções
await sendMessage(project.id, {
  message: "Adicione essas imagens na seção de serviços",
  asset_ids: [image1.id, image2.id]
});
```

### Exemplo 4: Skill Customizada

```typescript
// Criar skill para estilo específico
const skill = await createSkill({
  name: "Estilo Minimalista Premium",
  description: "Design minimalista com acabamento premium",
  instructions: `
    - Paleta monocromática com 1 accent color vibrante
    - Tipografia: Inter Display para títulos, Inter para corpo
    - Espaçamentos generosos (3-5rem entre seções)
    - Componentes com bordas sutis e sombras suaves
    - Animações discretas apenas em hover/focus
    - Grid assimétrico para quebrar monotonia
  `,
  category: "design",
  tags: ["minimalista", "premium", "clean", "moderno"],
  trigger_mode: "automatic",
  priority: 10
});

// Usar em projeto
await updateProject(project.id, {
  selected_skill_ids: [skill.id]
});
```

---

## 🔄 Ciclo de Vida Completo

```
1. CRIAÇÃO
   User cria projeto → Sistema gera starter files → Projeto em "draft"
   
2. DESENVOLVIMENTO
   User envia mensagens → Agent edita files → Validação automática
   ├─ Run criado (queued)
   ├─ Worker processa (planning/editing/validating)
   ├─ Tools manipulam workspace virtual
   ├─ Validação estática + build + QA visual
   └─ Revisão criada (se sucesso) OU erro registrado
   
3. ITERAÇÃO
   User pede alterações → Agent aplica patches ou reescreve
   ├─ Edição pontual (patch only) para mudanças simples
   └─ Edição completa para mudanças estruturais
   
4. PUBLICAÇÃO
   User solicita deploy → Build final → Upload Cloudflare
   ├─ Validação final
   ├─ Geração de artifact completo
   ├─ Deploy no Cloudflare Pages
   └─ URL pública gerada e registrada
   
5. MANUTENÇÃO
   User continua editando → Novas revisões → Re-deploy quando necessário
```

---

## 📝 Checklist de Deploy

### Antes de Publicar

- [ ] Build passa sem erros
- [ ] Validação estática 100% limpa
- [ ] Screenshots desktop gerado com sucesso
- [ ] Conteúdo confirmado (sem placeholders)
- [ ] Assets otimizados e carregando
- [ ] CTA funcional e testado
- [ ] Responsivo em mobile
- [ ] Acessibilidade básica (alt texts, contraste)
- [ ] Performance aceitável (LCP < 3s)

### Após Publicação

- [ ] URL pública acessível
- [ ] DNS propagado (se domínio customizado)
- [ ] HTTPS funcionando
- [ ] Formulários enviando (se houver)
- [ ] WhatsApp abrindo (se for CTA)
- [ ] Analytics configurado (se houver)

---

## 🎯 Boas Práticas

### Para Usuários

1. **Seja específico nos pedidos**: "Mude a cor do botão principal para azul" > "Mude as cores"
2. **Um pedido por vez**: Evite "faça X, Y e Z" - divida em mensagens separadas
3. **Use assets apropriados**: Logo em PNG transparente, fotos em alta resolução
4. **Confirme dados do cliente**: Nome, telefone, endereço corretos antes de criar
5. **Teste antes de publicar**: Use preview para validar tudo
6. **Mantenha revisões organizadas**: Mensagens claras facilitam histórico

### Para Desenvolvedores

1. **Valide entrada**: Sempre valide dados do usuário com Zod
2. **Trate erros**: Catch promises, trate timeouts, logs claros
3. **Otimize queries**: Use select específico, índices, cache
4. **Monitore budget**: Alerte quando próximo do limite
5. **Teste edge cases**: Arquivo vazio, UTF-8 inválido, timeout
6. **Documente APIs**: Tipos claros, exemplos de uso, erros possíveis

### Para Skills

1. **Instruções claras**: Seja explícito, evite ambiguidade
2. **Exemplos concretos**: Mostre código, não apenas conceitos
3. **Tags relevantes**: Facilita ativação automática
4. **Prioridade correta**: Skills fundamentais > decorativas
5. **Teste isoladamente**: Ative apenas ela e valide resultado
6. **Versione mudanças**: Incremente version ao atualizar

---

## 🚨 Limites e Restrições

### Técnicas

- **50 arquivos** máximo por projeto
- **200KB** máximo por arquivo
- **3MB** total de arquivos
- **12 assets** máximo por run
- **12 rodadas** máximo por run normal
- **3 rodadas** máximo por edição cirúrgica
- **6 checkpoints** máximo por run
- **20 mensagens** de histórico no contexto

### Funcionais

- Apenas React + Vite (sem Next.js, Vue, Angular)
- Apenas dependências fixas (sem npm install)
- Apenas Tailwind CSS (sem Styled Components, CSS Modules)
- Apenas assets do projeto (sem URLs externas)
- Apenas formulário local ou WhatsApp (sem integrações complexas)

### Orçamento

- **800k tokens** total por run normal
- **60k tokens** total por edição cirúrgica
- **80k tokens** de saída por run normal
- **8k tokens** de saída por edição cirúrgica
- **2 correções** máximas após falha de build

---

## 📞 Suporte e Contato

### Logs e Debug

```typescript
// Ativar logs detalhados
localStorage.setItem("debug", "site-studio:*");

// Ver estado do run
console.log(await fetch(`/api/sites/${projectId}/runs/${runId}`).then(r => r.json()));

// Ver mensagens completas
console.log(await fetch(`/api/sites/${projectId}/messages`).then(r => r.json()));
```

### Reportar Problemas

1. Copie ID do projeto e do run
2. Capture screenshot do erro
3. Exporte mensagens do chat
4. Descreva passos para reproduzir
5. Envie para equipe de suporte

---

## 🎉 Conclusão

Este sistema permite criar sites profissionais através de conversas naturais com IA, com:
- ✅ Qualidade de design garantida (Impeccable)
- ✅ Validação automática completa (estática + build + visual)
- ✅ Deploy com um clique (Cloudflare Pages)
- ✅ Versionamento e histórico completo
- ✅ Edições cirúrgicas econômicas (patch only)
- ✅ Skills customizáveis
- ✅ Multi-modelo (OpenRouter)

**Versão da Documentação**: 1.0.0  
**Última Atualização**: 2024-01-08  
**Autor**: Sistema Site Studio  
**Licença**: Proprietário
