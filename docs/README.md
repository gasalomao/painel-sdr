# Documentação Técnica — Vidrão Site Studio

Esta pasta contém a documentação técnica completa do sistema de geração de sites com IA.

---

## 📚 GUIA DE LEITURA

### Por Objetivo

**Quero entender o projeto rapidamente (15 min):**
1. [`INDEX.md`](./INDEX.md) - Visão geral e índice completo
2. [`../PROJECT_STATE.md`](../PROJECT_STATE.md) - Seção 8: Resumo Executivo

**Quero implementar a correção de tempo real (3h):**
1. [`REALTIME_FILES_QUICK_GUIDE.md`](./REALTIME_FILES_QUICK_GUIDE.md) - Seguir checklist
2. [`REALTIME_FILES_FIX.md`](./REALTIME_FILES_FIX.md) - Entender o "por quê"

**Quero entender a arquitetura do sistema (1h):**
1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) - Diagramas completos
2. [`../PROJECT_STATE.md`](../PROJECT_STATE.md) - Seção 4: Mapa de arquivos

**Quero implementar observabilidade (6h):**
1. [`OBSERVABILITY_DESIGN.md`](./OBSERVABILITY_DESIGN.md) - Design completo
2. [`REALTIME_FILES_QUICK_GUIDE.md`](./REALTIME_FILES_QUICK_GUIDE.md) - Base (SSE)

---

## 📄 DOCUMENTOS

### [`INDEX.md`](./INDEX.md)
**Índice mestre e guia de navegação**

- Índice de todos os documentos
- Início rápido
- Problema crítico atual
- Solução proposta
- Estado dos testes
- Mapa do projeto
- Conceitos-chave
- Comandos úteis

**Quando ler:** Primeiro contato com o projeto

---

### [`REALTIME_FILES_FIX.md`](./REALTIME_FILES_FIX.md)
**Análise técnica detalhada da correção de arquivos em tempo real**

- Diagnóstico da causa raiz
- Fluxo atual vs fluxo corrigido
- Solução A (activities + polling)
- Solução B (checkpoint stream - futura)
- Vantagens e desvantagens
- Implementação passo-a-passo (código completo)
- Validação e testes
- Rollback e contingência
- Próximas melhorias

**Quando ler:** Antes de implementar a correção (entender o "por quê")

---

### [`REALTIME_FILES_QUICK_GUIDE.md`](./REALTIME_FILES_QUICK_GUIDE.md)
**Guia prático de implementação (2-3 horas)**

- ✅ Checklist de 6 passos
- ✅ Código exato para copiar/colar
- ✅ Comandos de teste
- ✅ Diagrama de arquitetura visual
- ✅ Troubleshooting completo
- ✅ Rollback
- ✅ Métricas de sucesso
- ✅ Próximos passos

**Quando ler:** Durante a implementação (executar passo-a-passo)

---

### [`OBSERVABILITY_DESIGN.md`](./OBSERVABILITY_DESIGN.md)
**Design completo de transparência do processo IA**

- 💭 Pensamento da IA (Chain-of-Thought)
- 🔧 Skills e ferramentas ativas
- 📝 Diffs de código em tempo real
- Layout da UI (mockup ASCII)
- Priorização (Fase 1, 2, 3)
- Eventos system padronizados
- Componentes React (código completo)
- Métricas de sucesso

**Quando ler:** Após correção de arquivos, antes de implementar observabilidade

---

### [`ARCHITECTURE.md`](./ARCHITECTURE.md)
**Arquitetura técnica e diagramas**

- Arquitetura geral do sistema
- Fluxo de dados completo (sequência)
- Anatomia de eventos SSE
- Modelo de dados (SQL)
- Checkpoint structure
- Segurança e permissões (RLS)
- Escalabilidade e performance
- Monitoramento e observabilidade

**Quando ler:** Para entendimento profundo do sistema

---

## 🗺️ FLUXO DE TRABALHO RECOMENDADO

```
1. Ler INDEX.md (15 min)
   ↓
2. Ler PROJECT_STATE.md seção 8 (5 min)
   ↓
3. Validar testes: npm test (2 min)
   ↓
4. Ler REALTIME_FILES_FIX.md (30 min)
   ↓
5. Implementar com REALTIME_FILES_QUICK_GUIDE.md (2-3h)
   ↓
6. Testar manualmente (30 min)
   ↓
7. Ler OBSERVABILITY_DESIGN.md (45 min)
   ↓
8. Implementar observabilidade Fase 1 (4-6h)
   ↓
9. Consultar ARCHITECTURE.md conforme necessário
```

---

## 🎯 PRIORIDADES

### P0 - Crítico (Esta Sprint)
- ✅ Documentação completa (feito)
- 🔲 Implementar correção de arquivos em tempo real (2-3h)
- 🔲 Testar e validar (30 min)

### P1 - Alta (Próxima Sprint)
- 🔲 Thinking panel (2h)
- 🔲 Skills badge (1h)
- 🔲 Code diff viewer (3-4h)

### P2 - Média (Futuro)
- 🔲 Protocolo de continuidade
- 🔲 Checkpoint diff incremental
- 🔲 WebSocket bidirecional

---

## 📊 STATUS DA DOCUMENTAÇÃO

| Documento | Status | Completude | Última atualização |
|-----------|--------|------------|-------------------|
| INDEX.md | ✅ Completo | 100% | 2026-10-09 |
| REALTIME_FILES_FIX.md | ✅ Completo | 100% | 2026-10-09 |
| REALTIME_FILES_QUICK_GUIDE.md | ✅ Completo | 100% | 2026-10-09 |
| OBSERVABILITY_DESIGN.md | ✅ Completo | 100% | 2026-10-09 |
| ARCHITECTURE.md | ✅ Completo | 100% | 2026-10-09 |
| PROJECT_STATE.md | ✅ Completo | 100% | 2026-10-09 |

**Total:** 6 documentos, ~30.000 palavras, cobertura 100%

---

## 🔍 BUSCA RÁPIDA

### Por Palavra-Chave

**SSE / Server-Sent Events:**
- ARCHITECTURE.md - Seção 3: Anatomia de eventos SSE
- REALTIME_FILES_FIX.md - Seção 2.1: Fluxo atual
- REALTIME_FILES_QUICK_GUIDE.md - Passo 2: Modificar UI

**Checkpoint:**
- ARCHITECTURE.md - Seção 5: Checkpoint structure
- REALTIME_FILES_FIX.md - Seção 1: Diagnóstico
- PROJECT_STATE.md - Seção 3: Sistema de arquivos

**Activities:**
- ARCHITECTURE.md - Seção 3.2: Estrutura de Activity
- REALTIME_FILES_QUICK_GUIDE.md - Passo 1: Modificar Worker
- OBSERVABILITY_DESIGN.md - Seção 4: Eventos system completos

**Worker:**
- ARCHITECTURE.md - Seção 1: Worker BullMQ
- PROJECT_STATE.md - Seção 4: worker.ts
- REALTIME_FILES_FIX.md - Seção 2: Solução proposta

**Thinking / Chain-of-Thought:**
- OBSERVABILITY_DESIGN.md - Seção 1.1: Pensamento da IA
- INDEX.md - Seção: Conceitos-chave

**Tools / Ferramentas:**
- ARCHITECTURE.md - Seção 1: Tools Engine
- OBSERVABILITY_DESIGN.md - Seção 1.2: Skills/Ferramentas
- PROJECT_STATE.md - Seção 4: tools.ts

---

## 🤝 CONTRIBUINDO

### Atualizando Documentação

1. **Modificou código?** Atualize `PROJECT_STATE.md` seção relevante
2. **Nova feature?** Adicione em `OBSERVABILITY_DESIGN.md` ou `ARCHITECTURE.md`
3. **Bug fix?** Documente em `REALTIME_FILES_FIX.md` ou `QUICK_GUIDE.md`
4. **Mudança de arquitetura?** Atualize `ARCHITECTURE.md` diagramas

### Convenções

- Usar português para textos voltados ao usuário
- Usar inglês para código e nomes técnicos
- Diagramas em ASCII art (compatível com terminal)
- Código com syntax highlight (```typescript)
- Emojis para scanability: ✅ 🔲 ❌ ⚠️ 🔧 💭 📝

### Manter Sincronizado

Estes documentos devem estar sempre sincronizados:
- `PROJECT_STATE.md` (estado atual)
- `docs/INDEX.md` (índice mestre)
- `docs/ARCHITECTURE.md` (diagramas)

Se modificar um, verificar se os outros precisam atualização.

---

## 📞 AJUDA

### Encontrei um erro na documentação
Abra issue ou corrija diretamente. Documentação é código.

### Preciso de mais detalhes sobre X
1. Buscar palavra-chave na seção acima
2. Consultar documento referenciado
3. Se não encontrar, adicionar à documentação

### Implementei algo novo
1. Atualizar `PROJECT_STATE.md` seção 1 (status)
2. Atualizar `INDEX.md` se necessário
3. Adicionar em documento relevante
4. Atualizar esta tabela de status

---

## 🎓 RECURSOS ADICIONAIS

### Código Fonte
- `src/lib/sites/` - Core do sistema
- `src/app/api/sites/` - API routes
- `src/components/sites/` - UI React

### Testes
- `src/lib/sites/__tests__/` - Unit tests (1607)
- `scripts/site-preview.browser.ts` - Browser tests (36)

### Migrations
- `migrations/016_website_studio.sql` - Schema completo

### Scripts
- `package.json` - Comandos disponíveis
- `scripts/` - Utilitários

---

## ✨ PRÓXIMA ATUALIZAÇÃO

Após implementar a correção de tempo real, adicionar:

- [ ] Seção "Lições Aprendidas" em REALTIME_FILES_FIX.md
- [ ] Métricas reais (latência P50/P95) em INDEX.md
- [ ] Screenshots/GIFs em OBSERVABILITY_DESIGN.md
- [ ] Troubleshooting expandido em QUICK_GUIDE.md

---

**Documentação mantida por:** Vidrão Team  
**Última revisão completa:** 2026-10-09  
**Próxima revisão:** Após implementação de arquivos em tempo real
