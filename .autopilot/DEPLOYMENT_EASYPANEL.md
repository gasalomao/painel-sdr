# Deployment EasyPanel

Status: `TODO` — arquitetura e runbook serão validados.

## Topologia-alvo a avaliar

- `salomao-web`: Next.js standalone.
- `salomao-worker`: jobs duráveis quando implementados.
- `salomao-scraper`: somente se isolamento provar benefício.
- Evolution isolada operacionalmente.
- Supabase gerenciado preservado por padrão até análise econômica/operacional.

## A documentar

Comandos, portas internas, domínios, nomes de env, health checks, volumes, limites medidos, migrations, rollback e dependências. Nenhum valor secreto será incluído.
