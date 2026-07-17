# Estado Atual — Migração Evolution GO

> **Última atualização:** 2026-07-14
> **Agente:** Claude Code (ZCode)
> **Branch:** main
> **Commit:** ver `git log --oneline -1`

---

## O QUE FOI FEITO NESSA SESSÃO

1. **Organizador IA — kanban 100% adaptativo** (commit `3313704`):
   - Campo `is_terminal` em `kanban_columns` (migration)
   - 6 correções que eliminam hardcoded B2B
   - Toggle "Coluna final" na UI do organizador
   - Prompt mostra `[TERMINAL]` nas colunas finais

2. **Documentação de migração criada:**
   - `docs/research/EVOLUTION_GO.md` — pesquisa completa do Evolution GO (API, endpoints, Docker, config)
   - `docs/audit/AUDITORIA_SISTEMA_ATUAL.md` — inventário de 37 funcionalidades
   - `docs/migration/MIGRATION_PLAN.md` — plano de 6 fases

## ONDE ESTAMOS

**Fase concluída:** Documentação + Organizador IA
**Próxima fase:** Fase 1 — Instalação do Evolution GO no Easypanel

## PRÓXIMA AÇÃO EXATA

1. **Instalar Evolution GO no Easypanel** (Docker container):
   - Imagem: `evoapicloud/evolution-go`
   - Porta: 8080
   - Banco: criar `evogo_auth` + `evogo_users` no PostgreSQL existente
   - Configurar `GLOBAL_API_KEY` + `WEBHOOK_URL`
   - Ativar licença por email

2. **Criar adapter de provedor** (`src/lib/providers/`):
   - Interface comum (`sendMessage`, `getStatus`, `getQR`, `parseWebhook`)
   - `EvolutionGoProvider` implementando a interface
   - `EvolutionApiProvider` legado (fallback)
   - Config: `PROVIDER=evolution-go` no `.env`

## O QUE NÃO FOI FEITO AINDA

- Evolution GO **NÃO está instalado** ainda
- Adapter de provedor **NÃO existe** ainda
- Webhook do Evolution GO **NÃO existe** ainda
- Nenhuma linha de código de migração foi escrita — só documentação

## BLOQUEIOS

- **Nenhum bloqueio de código** — o plano está pronto pra implementar
- Evolution GO exige licença (registro por email) — precisa ser feita manualmente

## ARQUIVOS DE REFERÊNCIA

- `docs/research/EVOLUTION_GO.md` — tudo sobre o Evolution GO (API, endpoints, config)
- `docs/audit/AUDITORIA_SISTEMA_ATUAL.md` — inventário completo do sistema
- `docs/migration/MIGRATION_PLAN.md` — plano de migração em 6 fases
- `src/lib/channel.ts` — onde o provider atual (Evolution API) é chamado
- `src/app/api/webhooks/whatsapp/route.ts` — webhook atual (Evolution API)

## COMO CONTINUAR

1. Leia `docs/research/EVOLUTION_GO.md` pra entender o Evolution GO
2. Leia `docs/migration/MIGRATION_PLAN.md` pra saber o plano
3. Comece pela **Fase 2** (adapter de provedor) — é código puro, sem depender de infra
4. A **Fase 1** (instalação) precisa do Easypanel acessível
