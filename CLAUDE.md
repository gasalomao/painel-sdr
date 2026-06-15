@AGENTS.md

## Combo Workflow (Claude Code + Ruflo)

> Referência completa: [.claude/RUFLO_QUICKREF.md](.claude/RUFLO_QUICKREF.md)

**Regra de roteamento — sempre aplique antes de agir:**

| Complexidade | Ação |
|---|---|
| **Simples** (1 arquivo, edição direta, resposta) | Claude Code direto. Zero agente. |
| **Média** (2-5 arquivos, mesma camada) | Claude Code + Read paralelo. Sem agente. |
| **Complexa** (refactor amplo, debug difícil, multi-camada) | **1** agente Ruflo específico. |
| **Multi-frente real** (back + front + DB + testes) | Swarm 3-5 agentes max, com critério de parada. |

**Padrões obrigatórios:**
- Edição cosmética / refactor mecânico → use `cost-booster-edit` (WASM $0) antes de gastar token de LLM.
- Busca no codebase → `ctx_search` ou `Grep` focado, **nunca** `Read` em massa.
- Sessões longas (> 30min ou repo inteiro) → ligar `/cost-track` no início.
- Antes de spawnar swarm → justificar (em 1 linha): "frentes independentes porque X".

**Anti-padrões proibidos:**
- Spawnar agente "por garantia" sem justificativa.
- Manter agente vivo entre tarefas — encerrar e re-spawnar se voltar.
- Carregar `.env*` ou qualquer arquivo em `secrets/`. Já bloqueado em settings, mas reforço.

## Memória Compartilhada com Antigravity

> Este projeto usa memória compartilhada entre **Claude Code** e **Antigravity**.
> Quando os tokens de uma IA acabam, o usuário troca para a outra — e ela sabe tudo.

### Regras Obrigatórias

1. **No INÍCIO de cada sessão**: Leia os 4 arquivos de `.shared-memory/`:
   - `CONTEXT.md` — estado atual do projeto e o que está acontecendo
   - `MEMORY.md` — conhecimento persistente sobre o projeto
   - `SESSION_LOG.md` — o que a outra IA fez recentemente
   - `TASKS.md` — tarefas pendentes/em progresso

2. **DURANTE a sessão**: Atualize `.shared-memory/CONTEXT.md` quando:
   - Tomar uma decisão importante
   - Encontrar um problema/bug
   - Completar uma tarefa significativa
   - Mudar a direção do trabalho

3. **ANTES de encerrar**: Atualize todos os 4 arquivos:
   - `CONTEXT.md` — o que está acontecendo agora, onde parou
   - `MEMORY.md` — novos aprendizados sobre o projeto
   - `SESSION_LOG.md` — adicionar entrada com o que fez nesta sessão
   - `TASKS.md` — atualizar status das tarefas

4. **NUNCA** sobrescrever completamente um arquivo — sempre adicionar/atualizar seções

### Context-Mode (Economia de Tokens)
- context-mode está instalado como MCP server
- Use `ctx_execute` para rodar scripts ao invés de ler muitos arquivos
- Use `ctx_search` para buscar no índice ao invés de grep extensivo
- Use `ctx_index` para indexar conteúdo grande
- Use `ctx stats` para ver economia de tokens

### Formato do SESSION_LOG.md
```markdown
## [YYYY-MM-DD HH:MM] NomeDaIA — Descrição Curta
- **O que foi feito**: lista do que fez
- **Arquivos alterados**: lista de arquivos
- **Decisões**: decisões tomadas
- **Problemas**: bugs/issues encontrados
- **Estado ao sair**: onde parou, próximos passos
```
