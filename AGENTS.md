<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Economia de Token com RTK (Rust Token Killer)

Este projeto tem o **RTK** ativo via hook do Claude Code (`.claude/settings.json`).
O RTK intercepta comandos Bash e comprime a saída ANTES de mandar pra IA, economizando 60-90% de token em operações de desenvolvimento.

**Regras para a IA:**
- NÃO resista às reescritas do hook (`git status` → `rtk git status`). Elas são transparentes e economizam token.
- Use comandos Bash normalmente — o hook faz a otimização sozinho.
- Para ver a economia: `rtk gain` (mostra tokens salvos).
- Prefira comandos que o RTK otimiza: `git`, `ls`, `tree`, `find`, `grep`, `cat`, `diff`, `docker`, `pnpm`, `npm`.

---

## Memória Compartilhada com Claude Code

> Este projeto usa memória compartilhada entre **Antigravity** e **Claude Code**.
> Quando os tokens de uma IA acabam, o usuário troca para a outra — e ela sabe tudo.

### Regras Obrigatórias para o Antigravity

1. **No INÍCIO de cada sessão/conversa**: Leia os 4 arquivos de `.shared-memory/`:
   - `.shared-memory/CONTEXT.md` — estado atual do projeto e o que está acontecendo
   - `.shared-memory/MEMORY.md` — conhecimento persistente sobre o projeto
   - `.shared-memory/SESSION_LOG.md` — o que o Claude Code fez recentemente
   - `.shared-memory/TASKS.md` — tarefas pendentes/em progresso

2. **DURANTE a sessão**: Atualize `.shared-memory/CONTEXT.md` quando:
   - Tomar uma decisão importante
   - Encontrar um problema/bug
   - Completar uma tarefa significativa
   - Mudar a direção do trabalho

3. **ANTES de encerrar** ou quando o usuário pedir para parar: Atualize todos os 4 arquivos:
   - `CONTEXT.md` — o que está acontecendo agora, onde parou
   - `MEMORY.md` — novos aprendizados sobre o projeto
   - `SESSION_LOG.md` — adicionar entrada com o que fez nesta sessão (formato abaixo)
   - `TASKS.md` — atualizar status das tarefas

4. **NUNCA** sobrescrever completamente um arquivo — sempre adicionar/atualizar seções

### Formato do SESSION_LOG.md
```markdown
## [YYYY-MM-DD HH:MM] NomeDaIA — Descrição Curta
- **O que foi feito**: lista do que fez
- **Arquivos alterados**: lista de arquivos
- **Decisões**: decisões tomadas
- **Problemas**: bugs/issues encontrados  
- **Estado ao sair**: onde parou, próximos passos
```

### Economia de Tokens
- Evite ler arquivos grandes inteiros — use buscas direcionadas
- Resuma dados antes de processar
- Priorize ações diretas sobre análises exaustivas
