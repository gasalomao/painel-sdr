# Ruflo + Claude Code — Quick Reference

> Cheatsheet de quando usar o quê. **Regra de ouro:** menor custo + maior qualidade.
> Se a tarefa cabe em "simples", **não use agente nenhum**. Custo zero é melhor que custo baixo.

---

## Decisão em 3 segundos

```
Tarefa nova chegou → pergunte:

  1. É 1 arquivo, edição direta, ou resposta de texto?
     → Claude Code direto. Zero agente. Zero MCP. Stop.

  2. Envolve 2-5 arquivos, mesma camada (ex: 3 components React)?
     → Claude Code direto + Read paralelo. Sem agente.

  3. Envolve análise ampla / refactor / debug difícil / múltiplas camadas?
     → 1 agente Ruflo específico (ver tabela abaixo).

  4. Envolve frentes independentes (back + front + DB + testes)?
     → Swarm Ruflo. Máximo 3-5 agentes. Sempre com critério de parada.
```

---

## Tabela: tarefa → ferramenta

| Tarefa | Use isso | Custo |
|---|---|---|
| Refactor cosmético (renomear var, ajustar formatação) | `cost-booster-edit` (WASM, $0) | **Zero** |
| Bug em 1 arquivo, sei onde está | Claude Code direto, Edit | Baixo |
| Bug, não sei a causa | Claude Code direto + Grep amplo | Médio |
| Adicionar feature pequena (1-3 arquivos) | Claude Code direto | Médio |
| Refactor cruzando 10+ arquivos | Agent `code-analyzer` ou `refinement` | Alto |
| Debug crítico cruzando camadas | Agent `analyst` ou SPARC `debugger` | Alto |
| Arquitetura nova (escolher stack, pattern) | Agent `system-architect` | Alto |
| Review de PR / branch | `/review` ou Agent `reviewer` | Médio |
| Review de segurança | `/security-review` ou Agent `security-auditor` | Médio |
| Pesquisa "como X funciona no codebase?" | `ctx_search` (context-mode) | **Muito baixo** |
| Pesquisa ampla externa (docs, libs) | Agent `researcher` + WebSearch | Médio |
| Test generation | Agent `tester` ou `tdd-london-swarm` | Médio |
| Backend API novo | Agent `backend-dev` | Médio |
| Documentação OpenAPI | Agent `api-docs` | Baixo |
| Multi-frente real (back + front + DB) | Swarm: `hierarchical-coordinator` orquestra | Alto |

---

## Comandos de custo (use em sessões longas)

```
/cost-track         # liga rastreio na sessão atual
/cost-report        # mostra gasto até agora
/cost-budget-check  # quanto falta pro orçamento
/cost-optimize      # recomendações se gasto subir
/cost-compact-context  # comprime contexto antes de análise pesada
```

**Quando ativar:** sessões > 30min OU > 5 agentes spawneados OU análise de repo inteiro.

---

## Context-Mode (economia agressiva)

Use quando precisar entender o codebase **sem** ler arquivo por arquivo:

```
ctx_search "query"          # busca semântica indexada
ctx_index path              # indexa diretório
ctx_execute script.js       # roda script no contexto indexado
ctx_stats                   # mostra quanto token foi economizado
```

Substitui: vários `Read` + `Grep` quando você só precisa de resumo.

---

## Memória compartilhada (Antigravity ↔ Claude Code)

Antes de qualquer sessão, ler em ordem:
1. `.shared-memory/CONTEXT.md` — estado atual
2. `.shared-memory/SESSION_LOG.md` — o que a outra IA fez
3. `.shared-memory/TASKS.md` — pendências
4. `.shared-memory/MEMORY.md` — conhecimento estável

Antes de encerrar: atualizar `CONTEXT.md` + `SESSION_LOG.md` + `TASKS.md`.

---

## Anti-padrões (NÃO faça)

| Não faça | Faça |
|---|---|
| Spawnar swarm pra renomear variável | `cost-booster-edit` ou Edit direto |
| Rodar `Read` no repo inteiro | `ctx_search` ou `Grep` focado |
| Pedir 3 agentes pra mesma tarefa "pra ter certeza" | 1 agente, ou nenhum |
| Manter agente vivo "caso precise" | Encerrar quando entrega; spawnar de novo se voltar |
| Usar Opus pra formatar JSON | Haiku ou WASM tier |
| Carregar `.env*` | NUNCA. Bloqueado em settings.deny |

---

## Status do setup (validação rápida)

```bash
claude mcp list           # ruflo + context-mode devem aparecer Connected
claude plugin list        # ruflo-cost-tracker enabled
ls .claude/agents/        # 14 categorias de agentes Ruflo
ls .shared-memory/        # CONTEXT, MEMORY, SESSION_LOG, TASKS
```

Se algo faltar: ver [~/.claude/RUFLO_ECONOMIA.md](file:///C:/Users/Salomao/.claude/RUFLO_ECONOMIA.md) (instalação global).

---

## Quando considerar Hermes Agent (Nous Research)

**Não instalar por padrão.** Útil só se você quiser:
- Conversar com IA pelo Telegram/Discord/WhatsApp **fora** do VS Code
- Cron jobs pesados rodando 24/7 sem abrir o editor
- Trabalho em batch com modelos baratíssimos (OpenRouter)

Bridge possível: Hermes escreve em `.shared-memory/HERMES_OUT.md`, Claude Code lê na próxima sessão. Mas adiciona complexidade — só vale se o caso de uso for real.
