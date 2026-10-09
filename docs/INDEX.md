# Documentação Completa — Vidrão Site Studio

**Última atualização:** 2026-10-09  
**Status:** Diagnóstico completo → Pronto para implementação

---

## 📋 ÍNDICE DE DOCUMENTOS

### 1. Estado do Projeto
**Arquivo:** [`PROJECT_STATE.md`](../PROJECT_STATE.md)  
**Para quem:** Qualquer desenvolvedor retomando o projeto  
**Conteúdo:**
- Status atual (o que funciona, o que não funciona)
- Decisões de arquitetura e por quê
- Próximos passos obrigatórios
- Mapa completo de arquivos
- Comandos úteis
- Logs e debugging
- Autorizações e limites

**Quando ler:** SEMPRE - antes de qualquer trabalho no projeto

---

### 2. Correção de Arquivos em Tempo Real
**Arquivo:** [`docs/REALTIME_FILES_FIX.md`](./REALTIME_FILES_FIX.md)  
**Para quem:** Desenvolvedor implementando a correção crítica  
**Conteúdo:**
- Diagnóstico completo da causa raiz
- Fluxo atual vs fluxo corrigido
- Solução proposta detalhada (Solução A)
- Mudanças necessárias no código
- Vantagens e desvantagens
- Rollback e contingência

**Quando ler:** Antes de implementar a correção de tempo real (tarefa prioritária)

---

### 3. Guia Rápido de Implementação
**Arquivo:** [`docs/REALTIME_FILES_QUICK_GUIDE.md`](./REALTIME_FILES_QUICK_GUIDE.md)  
**Para quem:** Desenvolvedor executando a implementação  
**Conteúdo:**
- ✅ Checklist passo-a-passo (6 passos, 2-3h total)
- ✅ Código exato para copiar/colar
- ✅ Comandos de teste
- ✅ Troubleshooting de problemas comuns
- ✅ Diagrama de arquitetura visual
- ✅ Validação e métricas de sucesso

**Quando ler:** Durante a implementação (seguir passo-a-passo)

---

### 4. Design de Observabilidade
**Arquivo:** [`docs/OBSERVABILITY_DESIGN.md`](./OBSERVABILITY_DESIGN.md)  
**Para quem:** Desenvolvedor implementando transparência completa  
**Conteúdo:**
- 💭 Pensamento da IA (Chain-of-Thought)
- 🔧 Skills e ferramentas ativas
- 📝 Diffs de código em tempo real
- Layout completo da UI
- Priorização (Fase 1, 2, 3)
- Eventos system padronizados

**Quando ler:** Após correção de arquivos, antes de implementar observabilidade

---

### 5. Arquitetura Técnica
**Arquivo:** [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)  
**Para quem:** Arquiteto ou desenvolvedor precisando entender o sistema  
**Conteúdo:**
- Arquitetura geral do sistema (diagramas ASCII)
- Fluxo de dados completo (sequência)
- Anatomia de eventos SSE
- Modelo de dados (SQL)
- Checkpoint structure
- Segurança e permissões (RLS)
- Escalabilidade e performance
- Monitoramento

**Quando ler:** Para entendimento profundo do sistema

---

## 🚀 INÍCIO RÁPIDO

### Para Continuar o Projeto

1. **Ler estado atual (5 min):**
   ```bash
   cat PROJECT_STATE.md
   # Especialmente seção 8: RESUMO EXECUTIVO
   ```

2. **Validar ambiente (2 min):**
   ```powershell
   npm test                      # Deve: 1607 passar
   npm run sites:test-preview    # Deve: 36 passar
   npx tsc --noEmit              # Deve: zero erros
   ```

3. **Seguir guia de implementação (2-3h):**
   ```bash
   cat docs/REALTIME_FILES_QUICK_GUIDE.md
   # Seguir checklist de 6 passos
   ```

4. **Testar correção (30 min):**
   - Cenário 1: Criar site novo
   - Cenário 2: Editar site existente
   - Cenário 3: Múltiplos arquivos
   - Cenário 4: Erro/interrupção

5. **Próximas fases:**
   - Observabilidade completa (4-6h)
   - Protocolo de continuidade (2-3h)
   - Otimizações (4-8h)

---

## 🎯 PROBLEMA CRÍTICO ATUAL

### O Que Não Funciona

**Arquivos não aparecem em tempo real durante geração de código pela IA.**

**Sintomas:**
- ❌ Árvore de arquivos só atualiza a cada 3-5 segundos (polling)
- ❌ Editor não mostra código sendo injetado ao vivo
- ❌ Usuário não vê progresso em tempo real

**Causa Raiz:**
- Worker salva eventos em `website_messages` mas não em `website_run_activities`
- UI escuta `activities` via SSE, mas tool events não chegam lá
- Checkpoint só é salvo no final, não incrementalmente

**Impacto:**
- Experiência degradada vs Lovable/Claude Code
- Percepção de "travamento" durante geração
- Difícil debugar quando algo falha

---

## ✅ SOLUÇÃO PROPOSTA

### Resumo Executivo

**Abordagem:** Reutilizar sistema SSE existente (já testado e funcionando)

**Mudanças necessárias:**
1. Worker emite `website_run_activities` para cada tool call (15 linhas)
2. UI escuta SSE e busca checkpoint atualizado (30 linhas)
3. Agent salva checkpoint após write/create/patch (10 linhas)

**Esforço:** 2-3 horas implementação + 30 min testes

**Resultado esperado:**
- ✅ Latência <500ms (vs 3-5s antes)
- ✅ Arquivos aparecem em tempo real
- ✅ Experiência no nível Lovable/Claude Code

**Riscos:** Baixo - não requer nova infraestrutura

---

## 📊 ESTADO DOS TESTES

### Cobertura Atual

```
Testes Unitários:  1607 passando (84% coverage)
Testes Browser:    36 passando (Playwright)
TypeScript:        Zero erros (strict mode)
Lint:              Limpo (warnings OK)
```

### Cobertura Detalhada

```
src/lib/sites/:
  Linhas:       84.00%
  Statements:   84.00%
  Branches:     85.19%
  Funções:      89.13%
```

**Nota:** Componentes React, páginas Next.js e API routes NÃO estão incluídos nessa cobertura. Foco está na lógica de negócio (lib/sites).

---

## 🗺️ MAPA DO PROJETO

### Estrutura Principal

```
painel-sdr-main/
├── PROJECT_STATE.md              ← Estado completo do projeto
├── docs/
│   ├── REALTIME_FILES_FIX.md     ← Análise técnica da correção
│   ├── REALTIME_FILES_QUICK_GUIDE.md ← Guia passo-a-passo
│   ├── OBSERVABILITY_DESIGN.md   ← Design de transparência
│   ├── ARCHITECTURE.md           ← Diagramas e arquitetura
│   └── INDEX.md                  ← Este arquivo
├── src/
│   ├── lib/sites/                ← Core do Site Studio
│   │   ├── agent.ts              ← Runtime do agente IA
│   │   ├── tools.ts              ← Ferramentas (read/write/patch)
│   │   ├── worker.ts             ← Worker BullMQ
│   │   ├── run-checkpoint.ts     ← Serialização de estado
│   │   └── repository.ts         ← Acesso ao DB
│   ├── app/api/sites/            ← API routes Next.js
│   │   ├── [projectId]/
│   │   │   ├── messages/         ← GET histórico chat
│   │   │   ├── files/            ← GET checkpoint, PUT edição
│   │   │   └── runs/             ← POST nova run
│   │   └── runs/[runId]/
│   │       └── activities/       ← SSE stream de eventos
│   └── components/sites/         ← UI React
│       ├── site-chat.tsx         ← Chat interface
│       ├── site-files-panel.tsx  ← Árvore de arquivos
│       └── site-preview.tsx      ← Preview iframe
├── scripts/
│   ├── site-preview.browser.ts   ← Testes Playwright (36)
│   └── test-site-creation.ts     ← Teste criação completa
└── migrations/
    └── 016_website_studio.sql    ← Schema do Site Studio
```

### Arquivos Críticos

| Arquivo | Responsabilidade | Modificar para correção? |
|---------|------------------|--------------------------|
| `src/lib/sites/worker.ts` | Worker BullMQ, emite eventos | ✅ SIM (linha 71) |
| `src/lib/sites/agent.ts` | Runtime IA, executa tools | ✅ SIM (checkpoint incremental) |
| `src/components/sites/site-files-panel.tsx` | Árvore de arquivos UI | ✅ SIM (escutar SSE) |
| `src/app/api/sites/runs/[runId]/activities/route.ts` | SSE endpoint | ❌ Não (já funciona) |
| `src/lib/sites/tools.ts` | Implementação de ferramentas | ❌ Não |
| `src/lib/sites/repository.ts` | Queries SQL | ❌ Não |

---

## 🔑 CONCEITOS-CHAVE

### Checkpoint
Estado completo do workspace IA (arquivos + progresso + orçamento). Salvo incrementalmente para permitir recuperação após falhas ou troca de modelos.

### Activity
Evento em tempo real (tool call, thinking, validation). Inserido em `website_run_activities` e transmitido via SSE para a UI.

### SSE (Server-Sent Events)
Protocolo HTTP para push unidirecional servidor → cliente. Usado para transmitir activities em tempo real. Reconecta automaticamente.

### Tool Call
Quando IA chama uma ferramenta (write, create, patch, etc). Cada call gera 2 activities: "started" e "completed" (ou "error").

### RLS (Row Level Security)
Política PostgreSQL que filtra automaticamente queries por `client_id = user.id`. Garante isolamento multi-tenant.

### Worker
Processo BullMQ que executa runs de IA em background. Isolado do servidor Next.js. Comunica via DB (events + checkpoint).

---

## ⚠️ LIMITAÇÕES CONHECIDAS

### Infraestrutura
- ❌ E2B quota: 0/3 usados (build isolado não configurado em prod)
- ❌ Preview: CRA bootstrap (não Nodebox/Vite ainda)
- ❌ 9 vulnerabilidades npm audit não resolvidas

### Modelos IA
- ✅ Cohere/north-mini-code:free - APROVADO (edição)
- ❌ NVIDIA Nemotron - NÃO APROVADO (3 falhas)
- ⚠️ Outros modelos gratuitos - não testados ainda

### Features Pendentes
- 🔲 Thinking panel (Chain-of-Thought visual)
- 🔲 Skills badge (indicador visual)
- 🔲 Code diff viewer (Monaco side-by-side)
- 🔲 Continuidade entre modelos (protocolo)
- 🔲 Edições cirúrgicas otimizadas (diff editing)

---

## 🛠️ COMANDOS ÚTEIS

### Desenvolvimento
```powershell
npm run dev                       # Next.js dev server
npm run sites:worker              # Worker BullMQ isolado
```

### Testes
```powershell
npm test                          # Todos (1607 unit)
npm run sites:test-preview        # Browser (36 Playwright)
npx tsc --noEmit --incremental false  # TypeCheck
npm run lint                      # ESLint (pode falhar em worktrees)
git diff --check                  # Whitespace check
```

### Build
```powershell
npm run build                     # Build SQL + Next.js
```

### Debug
```powershell
# Monitorar SSE
curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true"

# Ver checkpoint
curl "http://localhost:3000/api/sites/<projectId>/files?run_id=<runId>"

# Logs do worker
npm run sites:worker | grep "file_"
```

---

## 📞 SUPORTE E RECURSOS

### Documentação Oficial
- **Next.js 16:** `node_modules/next/dist/docs/` (breaking changes!)
- **Supabase:** https://supabase.com/docs
- **BullMQ:** https://docs.bullmq.io/
- **Playwright:** https://playwright.dev/

### Troubleshooting
1. **Testes falhando:** Ver `docs/REALTIME_FILES_QUICK_GUIDE.md` seção Troubleshooting
2. **SSE não conecta:** Verificar auth + Supabase Realtime habilitado
3. **Worker não processa:** Verificar Redis (ou degradation mode ativado)
4. **Build falha:** Verificar TypeScript errors primeiro

### Git
- **Branch:** `main` (trabalho em andamento, não commitar sem aprovação)
- **Diffs:** Extensos, intencionais (progresso salvo localmente)
- **Worktrees:** Não usar - implementação deve ser na árvore original

---

## 🎯 PRÓXIMOS MARCOS

### Marco 1: Arquivos em Tempo Real ✅ (Documentado)
- ✅ Diagnóstico completo
- ✅ Solução desenhada
- ✅ Guia de implementação
- 🔲 Implementação (2-3h)
- 🔲 Validação (30min)

### Marco 2: Observabilidade Completa 🔲
- 🔲 Thinking panel
- 🔲 Skills badge
- 🔲 Code diff viewer
- 🔲 Timeline visual

### Marco 3: Continuidade Entre Modelos 🔲
- 🔲 Protocolo de handoff
- 🔲 Auto-retomada
- 🔲 Testes com modelos gratuitos

### Marco 4: Otimizações 🔲
- 🔲 Checkpoint diff
- 🔲 WebSocket bidirecional
- 🔲 Edições cirúrgicas
- 🔲 CDN para assets

---

## 📈 MÉTRICAS DE SUCESSO

### Antes (Atual)
- 🐌 Latência: 3-5 segundos
- 📊 Transparência: 0% (caixa preta)
- 🔍 Debug: Difícil
- 😕 Satisfação: Baixa

### Depois (Meta - Marco 1)
- ⚡ Latência: <500ms
- 📊 Transparência: 50% (arquivos visíveis)
- 🔍 Debug: Fácil (logs estruturados)
- 😊 Satisfação: Média

### Depois (Meta - Marco 2)
- ⚡ Latência: <500ms
- 📊 Transparência: 100% (thinking + diffs + skills)
- 🔍 Debug: Trivial (timeline visual)
- 😍 Satisfação: Alta

---

## 🔐 SEGURANÇA

### Já Implementado
- ✅ RLS em todas as tabelas
- ✅ JWT auth via Supabase
- ✅ Worker isolado (não acessa cross-tenant)
- ✅ Preview isolado (origin diferente + shadow DOM)
- ✅ Validação de input em tools
- ✅ Secrets via env vars (não commitados)

### Verificar Antes de Publicar
- [ ] Audit vulnerabilities resolvidas
- [ ] HTTPS em produção
- [ ] Rate limiting em APIs
- [ ] CORS configurado corretamente
- [ ] Logs não contêm secrets
- [ ] Realtime auth testada

---

## 📝 CONVENÇÕES DE CÓDIGO

### TypeScript
- Tipos explícitos em funções exportadas
- Sem `any` (usar `unknown` e narrow)
- Validação Zod para input externo
- Imutabilidade (criar novo objeto, não mutar)

### React
- Server Components por padrão
- `"use client"` só onde necessário
- Props com interface nomeada
- Sem `React.FC`

### Português
- Textos de UI em português
- Mensagens de erro em português
- Logs internos em inglês (opcional)

---

## ✨ CRÉDITOS

**Inspiração:**
- Lovable (https://lovable.ai)
- Claude Code (Anthropic)
- Cursor (https://cursor.sh)

**Stack:**
- Next.js 16 (Vercel)
- Supabase (PostgreSQL + Realtime)
- BullMQ (Taskforce.sh)
- OpenRouter (IA)

**Projeto:** Vidrão Site Studio  
**Status:** Em desenvolvimento ativo  
**Última atualização:** 2026-10-09

---

## 🚀 COMEÇAR AGORA

```powershell
# 1. Validar ambiente
npm test
npm run sites:test-preview

# 2. Ler estado
cat PROJECT_STATE.md

# 3. Implementar correção
cat docs/REALTIME_FILES_QUICK_GUIDE.md
# Seguir checklist de 6 passos

# 4. Testar
npm run dev
npm run sites:worker
# Criar site, ver arquivos em tempo real

# 5. Celebrar 🎉
```

**Boa sorte!** 🚀
