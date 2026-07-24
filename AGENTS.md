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

## Memória Compartilhada Universal (Antigravity, Claude Code, Zcode, Freebuff, Cursor, Codebuff, etc.)

> Este projeto usa memória compartilhada persistente em `.shared-memory/`.
> Sempre que os tokens de uma IA acabam e você troca para outra (seja Antigravity, Claude Code, Zcode, Freebuff, Codebuff, Cursor, ou qualquer IDE/CLI), a nova IA saberá exatamente o estado e onde continuar.

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

## Protocolo Fable Method Obrigatório (Fable 5 Workflow - Todos os Modelos)

> **MANDATO DE EXECUÇÃO**: Todos os modelos e agentes de IA que operam neste projeto (Antigravity, Claude Code, OpenCode, Zcode, Freebuff, Cursor, Codebuff, etc.) DEVEM seguir estritamente o protocolo **Fable Method** (`skills/fable-method/SKILL.md`) em todas as tarefas, garantindo raciocínio e execução de alto nível independente da capacidade individual do modelo.

### Ciclo Fable Method (0 ➔ 1 ➔ 2 ➔ 3 ➔ 4 ➔ 5 ➔ 6)

```
ask ──► 0 Classificar ──► 1 Definir Pronto ──► 2 Evidências ──► 3 Decidir ──► 4 Agir ──► 5 Verificar ──► 6 Reportar
```

1. **Gate Trivial vs Completo**:
   - Tarefas triviais (1 arquivo, <10 linhas alteradas, sem comportamento novo e sem busca): fazer a alteração, executar 1 checagem óbvia (re-ler ou rodar build/lint) e reportar em 1-2 frases.
   - Todas as outras tarefas: EXECUTAR O LOOP FABLE COMPLETO.

2. **Passo 0 — Classificar o Pedido**:
   - **Pergunta/Diagnóstico**: Analisar fontes primárias, apontar causas/achados, propor recomendação. NÃO alterar código.
   - **Plano-Primeiro**: Se o escopo for ambíguo, ações forem irreversíveis/externas ou plano foi solicitado ➔ montar o plano e PARAR para aprovação.
   - **Tarefa**: Executar as mudanças necessárias e verificar por observação real.

3. **Passo 1 — Definir "Pronto" (Define Done)**:
   - Nomear o critério de verificação exato (ex: `npx tsc --noEmit` passa com 0 erros, teste específico passa, rota devolve 200).

4. **Passo 2 — Coletar Evidências (Primary Sources Beat Memory)**:
   - NUNCA adivinhar assinaturas, rotas, tipos ou arquivos de memória.
   - Ler os arquivos e documentações reais do projeto antes de alterar qualquer código.
   - **Portão de Intenção**: Se um teste falhar ou algo divergir da especificação, verificar a intenção real no README/docstring antes de alterar. NUNCA enfraquecer testes para "forçar aprovação".

5. **Passo 3 — Decidir e Comprometer**:
   - Escolher UMA recomendação clara e cirúrgica. Respeitar o escopo declarado.

6. **Passo 4 — Agir de Forma Cirúrgica (Surgical Edits)**:
   - Menor alteração correta possível. Preservar o estilo do código existente.
   - Proibição estrita: NUNCA enfraquecer asserções de testes para fazer passar, NUNCA expor/apagar secrets, NUNCA alterar fora do escopo.

7. **Passo 5 — Verificar por Observação (Prove / Fable Judge)**:
   - Executar os comandos de verificação (`npx tsc --noEmit`, testes, builds ou chamadas) e observar a saída REAL.
   - **Verificação Gêmea (Twin Check)**: Ao corrigir um bug, buscar no projeto se o mesmo padrão incorreto se repete em outros locais (`TWINS: searched <pattern> - found <N> sites`).

8. **Passo 6 — Reportar Focado em Resultados (Outcome-First)**:
   - A primeira frase responde "o que aconteceu / qual o resultado".
   - Reportar evidências reais e ressalvas/caveats honestos.

## Suíte de Marketing Skills Integrada (coreyhaines31/marketingskills)

> **MANDATO DE MARKETING**: Todas as IAs e modelos que operam no projeto DEVEM utilizar as 48 sub-skills de marketing disponíveis em `skills/` e `.agents/skills/` sempre que o usuário solicitar tarefas de marketing, copywriting, anúncios, emails, SEO, CRO, precificação, landing pages, lead magnets, estratégias de conteúdo e growth.

### Regras de Execução de Marketing:
1. **Ativação Automática**: Se o usuário pedir para escrever copy, planejar campanhas, criar emails de prospecção, otimizar conversão (CRO), fazer auditoria SEO ou criar ofertas, a IA DEVE consultar a respectiva skill em `skills/<skill_name>/SKILL.md` antes de gerar o conteúdo.
2. **Exemplos de Mapeamento**:
   - Copywriting / Páginas de Vendas ➔ `skills/copywriting/SKILL.md`
   - Cold Email / Prospecção ➔ `skills/cold-email/SKILL.md` & `skills/prospecting/SKILL.md`
   - Otimização de Anúncios ➔ `skills/ads/SKILL.md` & `skills/ad-creative/SKILL.md`
   - SEO & Conteúdo ➔ `skills/seo-audit/SKILL.md`, `skills/ai-seo/SKILL.md` & `skills/content-strategy/SKILL.md`
   - Taxas de Conversão & Ofertas ➔ `skills/cro/SKILL.md` & `skills/offers/SKILL.md`


