# Estado Atual — Migração Evolution GO

> **Última atualização:** 2026-07-14
> **Agente:** Claude Code (ZCode)
> **Branch:** main
> **Commit:** f3c46fd

---

## RESUMO EXECUTIVO

A **Fase 2 (adapter)** e **Fase 3 (webhook)** estão **IMPLEMENTADAS e no GitHub**.
O código da migração está pronto. Falta apenas **instalar o Evolution GO** (infraestrutura) e testar.

## O QUE FOI FEITO

### Fase 2 — Adapter de Provedor (COMPLETO)
- `src/lib/providers/types.ts` — interface `WhatsAppProvider` com 7 métodos
- `src/lib/providers/evolution-go.ts` — implementação completa do Evolution GO
- `src/lib/channel.ts` — routing automático por `channel_connections.provider`:
  - `evolution` (legado, padrão)
  - `evolution_go` (novo, Go/whatsmeow)
  - `whatsapp_cloud` (Meta oficial)

### Fase 3 — Webhook Handler (COMPLETO)
- `src/app/api/webhooks/evolution-go/route.ts` — recebe eventos do GO
- Parse do payload `{ event, instance, data }` (formato whatsmeow)
- Anti-duplicação, salvar em `chats_dashboard`, disparar IA

### Documentação (COMPLETA)
- `docs/research/EVOLUTION_GO.md` — API completa do Evolution GO
- `docs/audit/AUDITORIA_SISTEMA_ATUAL.md` — inventário de 37 funcionalidades
- `docs/migration/MIGRATION_PLAN.md` — plano de 6 fases

## ONDE ESTAMOS

```
Fase 1 (instalação)    [ ] PENDENTE — precisa do Easypanel
Fase 2 (adapter)       [x] COMPLETO — commit f3c46fd
Fase 3 (webhook)       [x] COMPLETO — commit f3c46fd
Fase 4 (teste piloto)  [ ] PENDENTE — depende da Fase 1
Fase 5 (migração)      [ ] PENDENTE
Fase 6 (desativação)   [ ] PENDENTE
```

## PRÓXIMA AÇÃO EXATA

### 1. Instalar Evolution GO no Easypanel (Fase 1)
- Criar container Docker da imagem `evoapicloud/evolution-go`
- Porta: 8080
- Criar 2 databases no PostgreSQL: `evogo_auth` + `evogo_users`
- Configurar `.env`:
  ```
  SERVER_PORT=8080
  GLOBAL_API_KEY=<chave-segura>
  POSTGRES_AUTH_DB=postgresql://user:pass@host:5432/evogo_auth?sslmode=disable
  POSTGRES_USERS_DB=postgresql://user:pass@host:5432/evogo_users?sslmode=disable
  WEBHOOK_URL=https://sistema-sdr.ridnii.easypanel.host/api/webhooks/evolution-go
  CONNECT_ON_STARTUP=true
  ```
- Ativar licença (registro por email)
- Health check: `GET /server/ok` deve responder 200

### 2. Conectar número piloto (Fase 4)
- Criar instância no GO
- Ler QR code
- Conectar WhatsApp
- Enviar mensagem de teste → confirmar que chega no painel

### 3. Trocar provider da instância no banco
```sql
UPDATE channel_connections SET provider = 'evolution_go'
WHERE instance_name = 'nome-da-instancia-piloto';
```
Isso ativa o routing automático — o `channel.ts` passa a usar o Evolution GO pra essa instância.

## COMO O SISTEMA SABE QUAL PROVEDOR USAR

O `channel.ts` lê `channel_connections.provider`:
- Se for `evolution_go` → usa `evolutionGo` (novo adapter)
- Se for `evolution` → usa `evolution` (legado, padrão)
- Se for `whatsapp_cloud` → usa `whatsappCloud`

**Para trocar um número de provedor:** basta mudar o campo `provider` na tabela. O resto do sistema (IA, chat, organizador, disparo) não precisa de nenhuma mudança.

## BLOQUEIOS

- **Nenhum bloqueio de código.** Tudo está implementado.
- Precisa do Easypanel acessível para instalar o Evolution GO (Fase 1).
- O Evolution GO exige licença (registro por email).

## ARQUIVOS-CHAVE

| Arquivo | Função |
|---------|--------|
| `src/lib/providers/types.ts` | Interface comum do provedor |
| `src/lib/providers/evolution-go.ts` | Implementação do Evolution GO |
| `src/lib/channel.ts` | Router que decide qual provedor usar |
| `src/app/api/webhooks/evolution-go/route.ts` | Webhook handler do GO |
| `docs/research/EVOLUTION_GO.md` | Documentação completa do GO |
| `docs/migration/MIGRATION_PLAN.md` | Plano de migração |
