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

## Memória Compartilhada Universal (Antigravity, Claude Code, Zcode, Freebuff, Cursor, etc.)

> Este projeto usa memória compartilhada persistente em `.shared-memory/`.
> Sempre que os tokens de uma IA acabam e você troca para outra (seja Antigravity, Claude Code, Zcode, Freebuff, ou qualquer IDE/CLI), a nova IA saberá exatamente o estado e onde continuar.

### Regras Obrigatórias para TODOS os Agentes de IA

1. **No INÍCIO de cada sessão/conversa**: Leia os 4 arquivos de `.shared-memory/`:
   - [CONTEXT.md](file:///.shared-memory/CONTEXT.md) — estado atual do projeto e o que está acontecendo
   - [MEMORY.md](file:///.shared-memory/MEMORY.md) — conhecimento persistente sobre o projeto
   - [SESSION_LOG.md](file:///.shared-memory/SESSION_LOG.md) — histórico de sessões anteriores
   - [TASKS.md](file:///.shared-memory/TASKS.md) — lista de tarefas pendentes e em progresso

2. **DURANTE a sessão**: Atualize o [CONTEXT.md](file:///.shared-memory/CONTEXT.md) quando:
   - Tomar uma decisão técnica ou arquitetural importante
   - Encontrar um problema/bug relevante
   - Mudar o escopo ou direção do trabalho

3. **ANTES de encerrar** ou quando o usuário pedir para parar/trocar: Atualize os 4 arquivos:
   - [CONTEXT.md](file:///.shared-memory/CONTEXT.md) — o estado atual em que você está deixando o projeto
   - [MEMORY.md](file:///.shared-memory/MEMORY.md) — novos aprendizados e descobertas sobre a base de código
   - [SESSION_LOG.md](file:///.shared-memory/SESSION_LOG.md) — adicione uma nova entrada seguindo o formato abaixo
   - [TASKS.md](file:///.shared-memory/TASKS.md) — atualize o status das tarefas completas/pendentes

4. **NUNCA** sobrescreva completamente um arquivo — sempre adicione/atualize seções de forma incremental.

### Formato do SESSION_LOG.md
```markdown
## [YYYY-MM-DD HH:MM] NomeDaIA/IDE — Descrição Curta
- **O que foi feito**: lista do que fez
- **Arquivos alterados**: lista de arquivos
- **Decisões**: decisões tomadas
- **Problemas**: bugs/issues encontrados  
- **Estado ao sair**: onde parou, próximos passos
```

### Economia de Tokens
- Evite ler arquivos grandes inteiros — use buscas direcionadas
- Resuma dados antes de processar
- Priorize ações diretas sobre análises exaustivas e loops de diagnóstico
- Use as ferramentas de economia do RTK sempre que disponíveis
