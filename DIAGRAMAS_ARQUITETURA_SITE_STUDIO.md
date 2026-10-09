# 🏗️ Diagramas de Arquitetura - Site Studio

## Visão Geral do Sistema

```mermaid
graph TB
    subgraph "USUÁRIO"
        U[👤 Usuário]
    end
    
    subgraph "FRONTEND - Next.js"
        UI[🖥️ Interface Web]
        Pages[📄 Páginas]
        Components[🧩 Componentes]
    end
    
    subgraph "BACKEND - API Routes"
        API[🔌 API Routes]
        Agent[🤖 Agent Runtime]
        Tools[🛠️ Tools System]
        Validation[✅ Validation]
    end
    
    subgraph "DADOS - Supabase"
        DB[(🗄️ PostgreSQL)]
        Storage[📦 Storage]
        Auth[🔐 Auth]
    end
    
    subgraph "IA - OpenRouter"
        Models[🧠 Modelos IA]
    end
    
    subgraph "BUILD - E2B"
        Sandbox[📦 Sandbox Isolado]
    end
    
    subgraph "DEPLOY - Cloudflare"
        CDN[🌐 Cloudflare Pages]
    end
    
    U -->|Interage| UI
    UI -->|Requisições| API
    Pages -->|Usa| Components
    API -->|Processa| Agent
    Agent -->|Usa| Tools
    Agent -->|Valida| Validation
    API -->|Consulta/Salva| DB
    API -->|Upload/Download| Storage
    API -->|Autentica| Auth
    Agent -->|Chama| Models
    Validation -->|Build| Sandbox
    API -->|Publica| CDN
```

---

## Fluxo de Criação de Site

```mermaid
sequenceDiagram
    participant U as 👤 Usuário
    participant UI as 🖥️ Interface
    participant API as 🔌 API
    participant DB as 🗄️ Database
    participant Worker as ⚙️ Worker
    participant Agent as 🤖 Agent
    participant IA as 🧠 Modelo IA
    participant E2B as 📦 E2B Sandbox
    participant CF as 🌐 Cloudflare
    
    U->>UI: Criar novo site
    UI->>API: POST /api/sites
    API->>DB: Insere projeto
    API-->>UI: Retorna projeto
    
    U->>UI: "Crie um site moderno..."
    UI->>API: POST /api/sites/{id}/chat
    API->>DB: Cria RUN (queued)
    API-->>UI: Retorna run_id
    
    Worker->>DB: Busca runs pendentes
    Worker->>Agent: Processa run
    Agent->>DB: Carrega contexto
    Agent->>IA: Envia prompt + tools
    
    loop Iteração do Agente
        IA-->>Agent: Resposta + tool calls
        Agent->>Agent: Executa tools
        Agent->>IA: Resultados
    end
    
    Agent->>E2B: Valida + build
    E2B-->>Agent: Screenshots + artifact
    
    alt Build OK
        Agent->>DB: Cria revisão
        Agent->>DB: Atualiza run (completed)
        UI->>UI: Atualiza interface
    else Build falhou
        Agent->>IA: Corrige erros
        Agent->>E2B: Tenta novamente
    end
    
    U->>UI: Publicar
    UI->>API: POST /api/sites/{id}/deploy
    API->>E2B: Build final
    E2B-->>API: Artifact completo
    API->>CF: Deploy
    CF-->>API: URL pública
    API->>DB: Registra deployment
    API-->>UI: URL do site
```

---

## Arquitetura de Ferramentas (Tools)

```mermaid
graph LR
    subgraph "Agent Context"
        Agent[🤖 Agent]
    end
    
    subgraph "WebsiteTools Class"
        Tools[🛠️ Tools Manager]
        Workspace[📁 Virtual Workspace]
        Checkpoints[💾 Checkpoints]
        Direction[🎨 Design Direction]
    end
    
    subgraph "Ferramentas de Leitura"
        List[📋 list]
        Read[📖 read]
        ReadFiles[📚 read_files]
        Search[🔍 search]
        GetContext[ℹ️ get_context]
        Assets[🖼️ assets]
    end
    
    subgraph "Ferramentas de Escrita"
        Create[➕ create]
        Write[✏️ write]
        Patch[🩹 patch]
        Delete[🗑️ delete]
        Rename[🔄 rename]
    end
    
    subgraph "Ferramentas de Gestão"
        Checkpoint[💾 checkpoint]
        Restore[↩️ restore]
        Validate[✅ run_validation]
    end
    
    subgraph "Ferramentas Impeccable"
        ReadRef[📖 read_design_reference]
        RecordDir[🎨 record_design_direction]
    end
    
    Agent -->|Executa| Tools
    Tools -->|Gerencia| Workspace
    Tools -->|Salva/Restaura| Checkpoints
    Tools -->|Registra| Direction
    
    Tools --> List
    Tools --> Read
    Tools --> ReadFiles
    Tools --> Search
    Tools --> GetContext
    Tools --> Assets
    
    Tools --> Create
    Tools --> Write
    Tools --> Patch
    Tools --> Delete
    Tools --> Rename
    
    Tools --> Checkpoint
    Tools --> Restore
    Tools --> Validate
    
    Tools --> ReadRef
    Tools --> RecordDir
```

---

## Fluxo de Validação e Build

```mermaid
flowchart TD
    Start([Agent finaliza edição]) --> Static[✅ Validação Estática]
    
    Static -->|Passou| E2B[📦 Cria Sandbox E2B]
    Static -->|Falhou| ErrorStatic[❌ Erros de sintaxe]
    
    ErrorStatic --> Report1[📊 Relatório de erros]
    Report1 --> End1([Run falha])
    
    E2B --> Install[📦 npm install]
    Install --> Build[🏗️ npm run build]
    
    Build -->|Sucesso| Screenshot[📸 Captura screenshots]
    Build -->|Falhou| ErrorBuild[❌ Erro de build]
    
    ErrorBuild --> Analyze[🔍 Analisa tipo de erro]
    Analyze -->|Erro no código| Correct[🔧 Agent corrige]
    Analyze -->|Erro infra| Report2[📊 Relatório infra]
    
    Correct --> TryAgain{Tentativas < 2?}
    TryAgain -->|Sim| Static
    TryAgain -->|Não| Report3[📊 Limite atingido]
    
    Report2 --> End2([Run bloqueado])
    Report3 --> End3([Run falha])
    
    Screenshot --> Desktop[🖥️ Desktop 1440x900]
    Desktop --> QA[✅ QA Report]
    
    QA --> Package[📦 Gera artifact ZIP]
    Package --> Save[💾 Salva build no DB]
    Save --> Revision[📝 Cria revisão]
    Revision --> Success([✅ Run completo])
```

---

## Sistema de Budget

```mermaid
graph TB
    subgraph "Modo Normal (Agent)"
        AN[12 rodadas max]
        AT[800k tokens total]
        AO[80k tokens saída]
        AQ[3 rodadas QA]
        AC[2 correções]
    end
    
    subgraph "Modo Patch Only"
        PN[3 rodadas max]
        PT[60k tokens total]
        PO[8k tokens saída]
        PQ[2 rodadas QA]
        PC[1 correção]
    end
    
    subgraph "Decisão de Modo"
        Check{Site existe?<br/>Pedido simples?}
    end
    
    Start([Novo Run]) --> Check
    Check -->|Sim| Patch[Modo Patch Only]
    Check -->|Não| Normal[Modo Normal]
    
    Patch --> PN
    Patch --> PT
    Patch --> PO
    Patch --> PQ
    Patch --> PC
    
    Normal --> AN
    Normal --> AT
    Normal --> AO
    Normal --> AQ
    Normal --> AC
    
    PN --> Execute[Execução]
    PT --> Execute
    PO --> Execute
    PQ --> Execute
    PC --> Execute
    
    AN --> Execute
    AT --> Execute
    AO --> Execute
    AQ --> Execute
    AC --> Execute
    
    Execute --> Monitor{Budget OK?}
    Monitor -->|Sim| Continue[Continua]
    Monitor -->|Não| Stop[Budget Exceeded]
    
    Continue --> Done([Concluído])
    Stop --> Error([Erro])
```

---

## Fluxo Impeccable Design

```mermaid
flowchart TD
    Start([User solicita site]) --> SkillCheck{Skill Impeccable<br/>ativa?}
    
    SkillCheck -->|Não| Normal[Fluxo normal<br/>sem Impeccable]
    SkillCheck -->|Sim| LoadRef[📚 Carrega referências]
    
    LoadRef --> Catalog[📋 Catálogo disponível:<br/>- typography<br/>- color<br/>- spacing<br/>- layout<br/>- components<br/>- accessibility]
    
    Catalog --> ReadRefs[Agent lê referências<br/>via read_design_reference]
    
    ReadRefs --> NewSite{Site novo ou<br/>redesign?}
    
    NewSite -->|Sim| RequireDir[🎨 OBRIGATÓRIO:<br/>record_design_direction]
    NewSite -->|Não - edição| OptionalDir[🎨 OPCIONAL:<br/>record_design_direction]
    
    RequireDir --> RecordDir[Registra:<br/>- mode<br/>- palette<br/>- typography<br/>- layout<br/>- components<br/>- motion<br/>- voice]
    
    OptionalDir --> Build[Constrói/edita site]
    RecordDir --> Build
    
    Build --> Validate[✅ Valida aderência<br/>às direções]
    
    Validate -->|OK| QA[📦 Build + QA]
    Validate -->|Falhou| Retry[Agent refina]
    
    Retry --> Build
    QA --> Success([✅ Site Impeccable])
    
    Normal --> NormalBuild[Build padrão]
    NormalBuild --> NormalQA[QA padrão]
    NormalQA --> Done([✅ Concluído])
```

---

## Modelo de Dados

```mermaid
erDiagram
    PROJECTS ||--o{ REVISIONS : has
    PROJECTS ||--o{ RUNS : executes
    PROJECTS ||--o{ MESSAGES : contains
    PROJECTS ||--o{ ASSETS : uses
    PROJECTS ||--o{ DEPLOYMENTS : publishes
    REVISIONS ||--o{ BUILDS : validates
    REVISIONS ||--o{ DEPLOYMENTS : deploys
    RUNS ||--o{ MESSAGES : generates
    
    PROJECTS {
        uuid id PK
        uuid client_id FK
        string name
        string slug UK
        jsonb client_context
        text instructions
        string model_mode
        string model_id
        array selected_skill_ids
        jsonb cta
        string status
        uuid current_revision_id FK
        uuid published_deployment_id FK
        string published_url
        timestamp last_published_at
        timestamp created_at
        timestamp updated_at
        timestamp deleted_at
    }
    
    REVISIONS {
        uuid id PK
        uuid client_id FK
        uuid project_id FK
        uuid parent_id FK
        text message
        jsonb files
        string hash
        timestamp created_at
        uuid actor_id
    }
    
    RUNS {
        uuid id PK
        uuid client_id FK
        uuid project_id FK
        string kind
        string status
        text prompt
        string model_id
        uuid base_revision_id FK
        array asset_ids
        text error
        boolean cancel_requested
        timestamp lease_expires_at
        timestamp created_at
        timestamp updated_at
    }
    
    MESSAGES {
        uuid id PK
        uuid project_id FK
        uuid run_id FK
        string role
        text content
        timestamp created_at
    }
    
    ASSETS {
        uuid id PK
        uuid client_id FK
        uuid project_id FK
        string name
        string path
        string mime
        int size
        int width
        int height
        string purpose
        string status
        string url
        timestamp created_at
    }
    
    BUILDS {
        uuid id PK
        uuid revision_id FK
        string status
        bytea artifact
        jsonb screenshots
        text logs
        jsonb qa_report
        timestamp created_at
    }
    
    DEPLOYMENTS {
        uuid id PK
        uuid project_id FK
        uuid revision_id FK
        string url
        string status
        text error
        timestamp deployed_at
    }
```

---

## Ciclo de Vida de um Run

```mermaid
stateDiagram-v2
    [*] --> queued: Criado
    queued --> planning: Worker inicia
    planning --> editing: Agent processa
    editing --> editing: Loop de tools
    editing --> validating: Finaliza edição
    validating --> completed: Build OK
    validating --> failed: Build falhou
    validating --> editing: Corrige (< 2x)
    failed --> [*]
    completed --> [*]
    
    queued --> cancelled: User cancela
    planning --> cancelled: User cancela
    editing --> cancelled: User cancela
    validating --> cancelled: User cancela
    cancelled --> [*]
    
    note right of editing
        Agent usa tools:
        - read, write, patch
        - create, delete
        - checkpoint, restore
        - run_validation
    end note
    
    note right of validating
        Processo:
        1. Validação estática
        2. Build no E2B
        3. Screenshots
        4. QA Report
        5. Artifact
    end note
```

---

## Hierarquia de Skills

```mermaid
graph TD
    subgraph "Sistema de Skills"
        Skills[📚 Skills Pool]
    end
    
    subgraph "Tipos de Skills"
        Builtin[🏭 Built-in<br/>Sistema]
        Custom[🎨 Custom<br/>Cliente]
    end
    
    subgraph "Modos de Ativação"
        Always[⚡ Always<br/>Sempre ativa]
        Auto[🤖 Automatic<br/>Por tags]
        Manual[👆 Manual<br/>Seleção explícita]
    end
    
    subgraph "Categorias"
        Design[🎨 Design]
        SEO[🔍 SEO]
        A11y[♿ Acessibilidade]
        Perf[⚡ Performance]
        Content[📝 Conteúdo]
    end
    
    Skills --> Builtin
    Skills --> Custom
    
    Builtin --> Always
    Builtin --> Auto
    Custom --> Auto
    Custom --> Manual
    
    Always --> Impeccable[Impeccable Design]
    Auto --> Responsive[Design Responsivo]
    Manual --> Premium[Estilo Premium]
    
    Impeccable --> Design
    Responsive --> Design
    Premium --> Design
```

---

## Fluxo de Deploy

```mermaid
sequenceDiagram
    participant U as 👤 Usuário
    participant UI as 🖥️ Interface
    participant API as 🔌 API
    participant DB as 🗄️ Database
    participant E2B as 📦 E2B
    participant CF as 🌐 Cloudflare
    
    U->>UI: Clica "Publicar"
    UI->>API: POST /api/sites/{id}/deploy
    
    API->>DB: Busca revisão atual
    DB-->>API: Revisão + files
    
    API->>E2B: Cria sandbox
    E2B-->>API: Sandbox pronto
    
    API->>E2B: Envia files
    API->>E2B: npm install
    E2B-->>API: Dependências OK
    
    API->>E2B: npm run build
    
    alt Build sucesso
        E2B-->>API: Dist folder
        API->>E2B: Compacta para ZIP
        E2B-->>API: artifact.zip
        
        API->>CF: Inicia deploy
        API->>CF: Upload artifact
        CF->>CF: Processa deploy
        CF-->>API: Deploy completo
        CF-->>API: URL pública
        
        API->>DB: Registra deployment
        API->>DB: Atualiza projeto
        API-->>UI: Sucesso + URL
        UI->>U: Exibe site publicado
    else Build falhou
        E2B-->>API: Erro de build
        API-->>UI: Erro
        UI->>U: Exibe erro
    end
```

---

## Arquitetura de Checkpoints

```mermaid
graph LR
    subgraph "Agent Execution"
        Agent[🤖 Agent]
    end
    
    subgraph "WebsiteTools"
        Tools[🛠️ Tools Manager]
        Workspace[📁 Current Workspace]
        CheckMap[🗂️ Checkpoint Map]
    end
    
    subgraph "Checkpoints Storage"
        Initial[💾 initial<br/>Estado original]
        CP1[💾 before-colors<br/>Antes das cores]
        CP2[💾 after-header<br/>Header completo]
        CP3[💾 before-footer<br/>Antes do footer]
    end
    
    Agent -->|checkpoint| Tools
    Agent -->|restore| Tools
    
    Tools -->|Gerencia| Workspace
    Tools -->|Armazena| CheckMap
    
    CheckMap --> Initial
    CheckMap --> CP1
    CheckMap --> CP2
    CheckMap --> CP3
    
    Initial -.->|Restaura| Workspace
    CP1 -.->|Restaura| Workspace
    CP2 -.->|Restaura| Workspace
    CP3 -.->|Restaura| Workspace
    
    Workspace -.->|Salva| CheckMap
```

---

## Integração com OpenRouter

```mermaid
graph TB
    subgraph "Site Studio"
        Agent[🤖 Agent Runtime]
    end
    
    subgraph "OpenRouter"
        Gateway[🌐 OpenRouter Gateway]
    end
    
    subgraph "Provedores de IA"
        Anthropic[🤖 Anthropic<br/>Claude 3.5 Sonnet<br/>Claude 3 Opus<br/>Claude 3 Haiku]
        OpenAI[🤖 OpenAI<br/>GPT-4 Turbo<br/>GPT-4<br/>GPT-3.5 Turbo]
        Google[🤖 Google<br/>Gemini Pro<br/>Gemini Pro Vision]
        Others[🤖 Outros<br/>Meta Llama<br/>Mistral<br/>Cohere]
    end
    
    Agent -->|Requisição| Gateway
    Gateway -->|Roteamento| Anthropic
    Gateway -->|Roteamento| OpenAI
    Gateway -->|Roteamento| Google
    Gateway -->|Roteamento| Others
    
    Anthropic -->|Resposta| Gateway
    OpenAI -->|Resposta| Gateway
    Google -->|Resposta| Gateway
    Others -->|Resposta| Gateway
    
    Gateway -->|Resposta + uso| Agent
```

---

**Versão**: 1.0.0  
**Última Atualização**: 2024-01-08
