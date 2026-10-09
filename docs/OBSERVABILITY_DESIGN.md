# Observabilidade em Tempo Real — Vidrão Site Studio

**Objetivo:** Implementar transparência total do processo de geração de código pela IA  
**Inspiração:** Claude Code, Lovable, Cursor  
**Status:** Design completo → Implementação pendente

---

## 1. TRÊS PILARES DA OBSERVABILIDADE

### 1.1 Pensamento da IA (Chain-of-Thought)

**O que é:**
- Raciocínio interno antes de executar ferramentas
- "Vou criar um componente Header com logo e navegação"
- "Preciso garantir responsividade mobile"

**Por que importa:**
- Usuário entende **intenção** antes de ver código
- Debug mais fácil: "IA pensou X, mas fez Y"
- Confiança: processo transparente

**Como implementar:**

```typescript
// src/lib/sites/agent.ts - capturar reasoning do provider

async chat(messages: Message[]): Promise<ChatResult> {
  const response = await this.provider.chat({
    messages,
    // ✅ Solicitar reasoning explícito
    response_format: { type: "reasoning" } // OpenRouter/Anthropic
  });

  // ✅ Extrair reasoning antes do tool call
  const reasoning = response.reasoning || 
    extractThinking(response.content); // fallback parsing

  if (reasoning) {
    await this.deps.event(this.run, {
      role: "assistant",
      content: JSON.stringify({
        type: "thinking",
        content: reasoning,
        timestamp: Date.now()
      })
    });
  }

  return response;
}

function extractThinking(content: string): string | null {
  // Padrões comuns:
  // "Vou criar..."
  // "Primeiro preciso..."
  // "<thinking>...</thinking>"
  
  const thinkingMatch = content.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (thinkingMatch) return thinkingMatch[1].trim();

  const planMatch = content.match(/^(Vou|Primeiro|Preciso|Agora vou)[\s\S]{20,500}?(?=\n\n|```)/i);
  if (planMatch) return planMatch[0].trim();

  return null;
}
```

**UI Component:**

```tsx
// src/components/sites/thinking-panel.tsx

export function ThinkingPanel({ runId }: { runId: string }) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/sites/runs/${runId}/activities?stream=true`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === "thinking") {
        setThoughts(prev => [...prev, {
          id: data.id,
          content: data.details.content,
          timestamp: data.timestamp
        }]);
      }
    };

    return () => eventSource.close();
  }, [runId]);

  return (
    <div className="border-l border-zinc-800 bg-zinc-950 w-80">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between"
      >
        <span className="font-medium">💭 Pensamento da IA</span>
        <ChevronDown className={expanded ? "" : "rotate-180"} />
      </button>

      {expanded && (
        <div className="px-4 py-2 space-y-3 max-h-[600px] overflow-y-auto">
          {thoughts.map(thought => (
            <div key={thought.id} className="text-sm text-zinc-400 space-y-1">
              <div className="text-xs text-zinc-600">
                {new Date(thought.timestamp).toLocaleTimeString()}
              </div>
              <div className="whitespace-pre-wrap">{thought.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 1.2 Skills/Ferramentas Ativas

**O que exibir:**
- Quais skills estão ativas na run atual
- Qual ferramenta está sendo executada agora
- Progresso: 3/7 ferramentas executadas

**Implementação:**

```typescript
// src/lib/sites/agent.ts - emitir skill activation

export async function executeRun(input: WebsiteRunInput) {
  // ✅ Emitir skills ativas no início
  if (input.activeSkills && input.activeSkills.length > 0) {
    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        type: "skills_activated",
        skills: input.activeSkills.map(s => ({
          id: s.id,
          name: s.name,
          category: s.category
        })),
        timestamp: Date.now()
      })
    });
  }

  // Durante execução, marcar tool ativo
  async executeTool(name: string, args: unknown): Promise<unknown> {
    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        type: "tool_started",
        tool: name,
        args: { path: args.path }, // metadados safe
        timestamp: Date.now()
      })
    });

    const result = await this.tools.execute(name, args);

    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        type: "tool_completed",
        tool: name,
        duration: Date.now() - startTime,
        timestamp: Date.now()
      })
    });

    return result;
  }
}
```

**UI Component:**

```tsx
// src/components/sites/skills-badge.tsx

export function SkillsBadge({ runId }: { runId: string }) {
  const [activeSkills, setActiveSkills] = useState<Skill[]>([]);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [toolProgress, setToolProgress] = useState({ current: 0, total: 0 });

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/sites/runs/${runId}/activities?stream=true`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === "skills_activated") {
        setActiveSkills(data.details.skills);
      }
      
      if (data.type === "tool_started") {
        setCurrentTool(data.details.tool);
        setToolProgress(prev => ({ ...prev, current: prev.current + 1 }));
      }
      
      if (data.type === "tool_completed") {
        setCurrentTool(null);
      }
    };

    return () => eventSource.close();
  }, [runId]);

  return (
    <div className="flex items-center gap-3">
      {/* Skills ativas */}
      {activeSkills.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 bg-blue-950/30 border border-blue-800 rounded-full">
          <Sparkles className="size-4 text-blue-400" />
          <span className="text-xs text-blue-300">
            {activeSkills.map(s => s.name).join(" · ")}
          </span>
        </div>
      )}

      {/* Tool atual */}
      {currentTool && (
        <div className="flex items-center gap-2 px-3 py-1 bg-amber-950/30 border border-amber-800 rounded-full animate-pulse">
          <Wrench className="size-4 text-amber-400" />
          <span className="text-xs text-amber-300">
            {currentTool} ({toolProgress.current}/{toolProgress.total || "?"})
          </span>
        </div>
      )}
    </div>
  );
}
```

---

### 1.3 Diffs de Código em Tempo Real

**O que exibir:**
- Código sendo injetado linha por linha
- Diff side-by-side (old vs new)
- Highlight de mudanças no editor

**Implementação:**

```typescript
// src/lib/sites/agent.ts - incluir diff nos eventos

async executeTool(name: string, args: unknown): Promise<unknown> {
  if (["write", "patch"].includes(name)) {
    const oldContent = this.tools.files[args.path] || "";
    const result = await this.tools.execute(name, args);
    const newContent = this.tools.files[args.path];

    // ✅ Emitir diff completo
    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        type: "code_diff",
        path: args.path,
        operation: name,
        diff: {
          old: oldContent.length > 5000 ? "[arquivo muito grande]" : oldContent,
          new: newContent.length > 5000 ? "[arquivo muito grande]" : newContent,
          hunks: computeHunks(oldContent, newContent) // unified diff format
        },
        timestamp: Date.now()
      })
    });

    return result;
  }

  return this.tools.execute(name, args);
}

function computeHunks(old: string, new: string): Hunk[] {
  // Usar biblioteca diff (e.g., diff-match-patch)
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(old, new);
  dmp.diff_cleanupSemantic(diffs);

  const hunks: Hunk[] = [];
  let currentHunk: string[] = [];
  let lineNumber = 1;

  for (const [op, text] of diffs) {
    const lines = text.split("\n");
    
    for (const line of lines) {
      if (op === 0) { // unchanged
        currentHunk.push(`  ${line}`);
      } else if (op === -1) { // deletion
        currentHunk.push(`- ${line}`);
      } else if (op === 1) { // insertion
        currentHunk.push(`+ ${line}`);
      }

      if (currentHunk.length > 0 && (currentHunk.length >= 10 || op !== 0)) {
        hunks.push({
          startLine: lineNumber,
          lines: currentHunk
        });
        currentHunk = [];
      }

      lineNumber++;
    }
  }

  return hunks;
}
```

**UI Component (Monaco Diff Editor):**

```tsx
// src/components/sites/code-diff-viewer.tsx

import { DiffEditor } from "@monaco-editor/react";

export function CodeDiffViewer({ runId }: { runId: string }) {
  const [diffs, setDiffs] = useState<CodeDiff[]>([]);
  const [selectedDiff, setSelectedDiff] = useState<CodeDiff | null>(null);

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/sites/runs/${runId}/activities?stream=true`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === "code_diff") {
        setDiffs(prev => [...prev, data.details]);
        setSelectedDiff(data.details); // auto-select mais recente
      }
    };

    return () => eventSource.close();
  }, [runId]);

  if (!selectedDiff) return null;

  return (
    <div className="h-[600px] flex flex-col border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header com selector */}
      <div className="px-4 py-3 bg-zinc-900 border-b border-zinc-800">
        <select
          value={selectedDiff.path}
          onChange={(e) => {
            const diff = diffs.find(d => d.path === e.target.value);
            setSelectedDiff(diff || null);
          }}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2"
        >
          {diffs.map(diff => (
            <option key={diff.path} value={diff.path}>
              {diff.operation === "patch" ? "📝" : "✨"} {diff.path}
            </option>
          ))}
        </select>
      </div>

      {/* Monaco Diff Editor */}
      <div className="flex-1">
        <DiffEditor
          original={selectedDiff.diff.old}
          modified={selectedDiff.diff.new}
          language="typescript"
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false }
          }}
        />
      </div>
    </div>
  );
}
```

---

## 2. LAYOUT DA UI (Proposta)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Vidrão Site Studio                                          [User]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌────────────────┐  ┌──────────────────────────────────────────┐  │
│  │  📁 Arquivos   │  │  💬 Chat                                  │  │
│  │                │  │                                            │  │
│  │  src/          │  │  User: Crie um header azul                │  │
│  │  ├─ App.tsx    │  │                                            │  │
│  │  ├─ Header.tsx │  │  💭 Pensamento:                            │  │
│  │  └─ Hero.tsx   │  │  "Vou criar Header.tsx com Tailwind...    │  │
│  │                │  │   usar bg-blue-600 e h-16..."             │  │
│  │  public/       │  │                                            │  │
│  │  └─ logo.svg   │  │  🔧 Executando:                            │  │
│  │                │  │  ✅ create: src/Header.tsx                 │  │
│  │  [3 arquivos]  │  │  ✅ patch: src/App.tsx                     │  │
│  │                │  │                                            │  │
│  │  ✨ Skills:     │  │  ✅ Site atualizado!                       │  │
│  │  • Design Pro  │  │                                            │  │
│  │  • Responsive  │  │                                            │  │
│  └────────────────┘  └──────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  📝 Editor                                    │  🖼️ Preview    │  │
│  │                                               │                │  │
│  │  src/Header.tsx                              │  [Site Live]   │  │
│  │  ┌────────────────────────────────┐          │                │  │
│  │  │ export function Header() {     │          │  +─────────────+  │
│  │  │   return (                     │          │  │ [Logo] Home │  │
│  │  │ +   <header className="h-16    │  diff    │  +─────────────+  │
│  │  │ +     bg-blue-600 flex         │  ← live  │                │  │
│  │  │ +     items-center px-8">      │          │  [Hero]        │  │
│  │  │       {/* ... */}              │          │                │  │
│  │  │     </header>                  │          │  [CTA Button]  │  │
│  │  │   );                           │          │                │  │
│  │  │ }                              │          │                │  │
│  │  └────────────────────────────────┘          │                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  🔧 Ferramentas: write (2) · patch (1) · checkpoint (1)              │
│  📊 Tokens: 12.5k input · 3.2k output · US$ 0.08                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Componentes Principais:

1. **Left Sidebar:** Árvore de arquivos + Skills badge
2. **Center:** Chat com thinking inline + tool activities
3. **Bottom Left:** Editor Monaco com diff highlighting
4. **Bottom Right:** Preview iframe (live reload)
5. **Status Bar:** Métricas de execução

---

## 3. PRIORIZAÇÃO DE IMPLEMENTAÇÃO

### Fase 1 (MVP — Esta Sprint)
- ✅ Arquivos em tempo real via SSE (já documentado)
- ✅ Tool activities no chat (já existe)
- 🔲 Skills badge visual
- 🔲 Thinking panel colapsável

### Fase 2 (Próxima Sprint)
- 🔲 Monaco diff editor integrado
- 🔲 Highlight de arquivo alterado na árvore
- 🔲 Progress bar de ferramentas

### Fase 3 (Futuro)
- 🔲 Timeline visual de ferramentas
- 🔲 Code lens inline no editor
- 🔲 Replay de execução (time travel)

---

## 4. EVENTOS SYSTEM COMPLETOS

### Tipos de Eventos (Padronizados)

```typescript
// src/lib/sites/types.ts

export type SystemEventType =
  // Pensamento
  | "thinking"           // Reasoning/CoT antes de agir
  
  // Skills
  | "skills_activated"   // Skills selecionadas para a run
  | "skill_applied"      // Skill específica aplicada
  
  // Ferramentas
  | "tool_started"       // Tool começou execução
  | "tool_completed"     // Tool terminou com sucesso
  | "tool_error"         // Tool falhou
  
  // Código
  | "code_diff"          // Diff de arquivo modificado
  | "file_created"       // Arquivo criado
  | "file_deleted"       // Arquivo deletado
  
  // Checkpoint
  | "checkpoint_saved"   // Checkpoint salvo
  | "checkpoint_restored" // Checkpoint restaurado
  
  // Validação
  | "validation_started" // Build/QA iniciado
  | "validation_passed"  // Build/QA aprovado
  | "validation_failed"  // Build/QA reprovou
  
  // Uso
  | "usage_recorded"     // Tokens consumidos
  | "quota_consumed";    // Quota (builds, etc)

export interface SystemEvent {
  type: SystemEventType;
  timestamp: number;
  details: Record<string, unknown>;
}
```

### Exemplo de Sequência Completa

```json
// 1. User envia mensagem
{ "role": "user", "content": "Adicione um footer azul" }

// 2. Thinking
{
  "role": "system",
  "content": {
    "type": "thinking",
    "content": "Vou criar Footer.tsx com bg-blue-600 e links de navegação. Preciso também importar no App.tsx."
  }
}

// 3. Tool started
{
  "role": "system",
  "content": {
    "type": "tool_started",
    "tool": "create",
    "args": { "path": "src/Footer.tsx" }
  }
}

// 4. Tool completed + diff
{
  "role": "system",
  "content": {
    "type": "code_diff",
    "path": "src/Footer.tsx",
    "operation": "create",
    "diff": {
      "old": "",
      "new": "export function Footer() { ... }",
      "hunks": [...]
    }
  }
}

// 5. Tool started (patch)
{
  "role": "system",
  "content": {
    "type": "tool_started",
    "tool": "patch",
    "args": { "path": "src/App.tsx" }
  }
}

// 6. Tool completed + diff
{
  "role": "system",
  "content": {
    "type": "code_diff",
    "path": "src/App.tsx",
    "operation": "patch",
    "diff": {
      "old": "export function App() { return <div>...</div>; }",
      "new": "import { Footer } from './Footer';\nexport function App() { return <div>...<Footer /></div>; }",
      "hunks": [
        { "startLine": 1, "lines": ["+ import { Footer } from './Footer';"] },
        { "startLine": 10, "lines": ["- </div>", "+ <Footer />", "+ </div>"] }
      ]
    }
  }
}

// 7. Checkpoint salvo
{
  "role": "system",
  "content": {
    "type": "checkpoint_saved",
    "version": "abc123",
    "filesCount": 5
  }
}

// 8. Usage registrado
{
  "role": "system",
  "content": {
    "type": "usage_recorded",
    "model": "cohere/north-mini-code:free",
    "usage": {
      "promptTokens": 8500,
      "completionTokens": 1200,
      "totalTokens": 9700
    }
  }
}

// 9. Resposta do assistente
{
  "role": "assistant",
  "content": "✅ Adicionei um footer azul com links de navegação. O componente está em `src/Footer.tsx` e já foi importado no App.tsx."
}
```

---

## 5. MÉTRICAS DE SUCESSO

### Antes (Estado Atual)
- ❌ Latência: 3-5 segundos até ver arquivos
- ❌ Transparência: 0% (caixa preta)
- ❌ Debug: "Por que não funcionou?" → sem resposta
- ❌ Confiança: Baixa (usuário não sabe o que está acontecendo)

### Depois (Meta)
- ✅ Latência: <500ms por arquivo
- ✅ Transparência: 100% (thinking + tools + diffs)
- ✅ Debug: Ver exatamente onde falhou
- ✅ Confiança: Alta (processo completamente visível)

### KPIs

- **Latência de atualização:** <500ms (P95)
- **Taxa de sucesso de render:** Árvore atualiza em 100% dos tool calls
- **Satisfação do usuário:** Survey NPS após implementação
- **Tempo de debug:** Redução de 50% no tempo para identificar problemas

---

## RESUMO EXECUTIVO

**Três pilares:**
1. 💭 **Thinking:** Mostrar raciocínio antes de agir
2. 🔧 **Skills/Tools:** Exibir qual skill/tool está ativo
3. 📝 **Diffs:** Código sendo injetado em tempo real

**Implementação:**
- Reutilizar SSE existente (`/activities`)
- Adicionar tipos de evento padronizados
- UI components modulares (ThinkingPanel, SkillsBadge, CodeDiffViewer)

**Esforço:**
- Fase 1 (MVP): 4-6 horas
- Fase 2 (Completo): +6-8 horas
- Fase 3 (Polish): +4-6 horas

**Dependências:**
- ✅ Sistema de arquivos em tempo real (doc anterior)
- ✅ SSE infrastructure (já existe)
- 🔲 Monaco diff editor (nova dependência)

**Resultado:**
- Transparência total do processo IA
- Debug 10x mais rápido
- Confiança do usuário aumentada
- Experiência no nível Lovable/Claude Code
