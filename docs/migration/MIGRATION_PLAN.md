# Plano de Migração — Painel SDR para Evolution GO

> **Data:** 2026-07-14
> **Decisão:** Migrar o provedor WhatsApp de Evolution API (Node.js) para Evolution GO (Go/whatsmeow).
> **Estratégia:** Migração gradual com coexistência — NÃO desligar o sistema atual.

---

## Objetivo

Substituir a Evolution API pela Evolution GO como provedor de WhatsApp do painel SDR, mantendo TODAS as funcionalidades atuais funcionando (IA, chat, disparo, organizador, etc).

## Princípios

1. **NÃO desligar o sistema atual** durante a migração
2. **Coexistência temporária**: Evolution API continua ativa enquanto Evolution GO é testada
3. **Camada de abstração**: criar um adapter que isola o provedor do resto do sistema
4. **Migração reversível**: poder voltar pra Evolution API se algo quebrar
5. **Uma instância por vez**: migrar número piloto primeiro, depois o resto

---

## Arquitetura-Alvo

```
WhatsApp
   ↓
Evolution GO (Go/whatsmeow, porta 8080)
   ↓ webhooks
Painel SDR (Next.js)
   ├── Adapter de provedor (isola Evolution GO do resto)
   ├── Webhook handler (formato Evolution GO)
   ├── Chat (mantém igual — lê de chats_dashboard)
   ├── IA (mantém igual — não sabe qual provedor)
   ├── Disparo (mantém igual — usa adapter)
   └── Organizador IA (mantém igual)
```

**Sem Chatwoot nesta fase.** O plano do documento mestre prevê Chatwoot como interface final, mas a prioridade imediata é trocar a Evolution API pela Evolution GO (mais rápida, mais estável, Go). Chatwoot vem depois como Fase 2.

---

## Fases

### Fase 1 — Instalação do Evolution GO (infraestrutura)
- [ ] Provisionar Evolution GO no Easypanel (Docker)
- [ ] Criar 2 databases PostgreSQL (`evogo_auth`, `evogo_users`)
- [ ] Configurar `.env` (API key, webhook URL, banco)
- [ ] Ativar licença (registro por email)
- [ ] Health check: `GET /server/ok` responde 200

### Fase 2 — Adapter de Provedor (código)
- [ ] Criar `src/lib/providers/` com interface comum
- [ ] Implementar `EvolutionGoProvider` (endpoints do GO)
- [ ] Manter `EvolutionApiProvider` (legado, fallback)
- [ ] Config selecionável: `PROVIDER=evolution-go|evolution-api`
- [ ] Adaptar `channel.ts` pra usar o provider selecionado

### Fase 3 — Webhook do Evolution GO
- [ ] Criar `src/app/api/webhooks/evolution-go/route.ts`
- [ ] Parse do payload do GO (formato diferente da API legada)
- [ ] Salvar em `chats_dashboard` + `messages` (mesmas tabelas)
- [ ] Anti-duplicação, upload de mídia (mesma lógica)
- [ ] Disparar agente IA (mesma lógica)

### Fase 4 — Teste com número piloto
- [ ] Conectar 1 número no Evolution GO (QR code)
- [ ] Receber mensagem de teste → confirmar que chega no chat
- [ ] Enviar mensagem pelo painel → confirmar que chega no WhatsApp
- [ ] Áudio → confirmar transcrição
- [ ] Imagem → confirmar descrição
- [ ] IA responde → confirmar fluxo completo

### Fase 5 — Migração gradual
- [ ] Migrar instâncias uma por uma
- [ ] Monitorar divergências
- [ ] Manter Evolution API ativa como fallback

### Fase 6 — Desativação da Evolution API (legado)
- [ ] Confirmar que tudo funciona só com Evolution GO
- [ ] Desligar Evolution API legada
- [ ] Remover código legado (com cuidado)

---

## O que NÃO muda
- Tudo que está acima do adapter: chat UI, IA, organizador, disparo, kanban, calendário
- As tabelas do banco (`chats_dashboard`, `messages`, `sessions`, etc)
- O agente de IA (não sabe qual provedor está usando)
- A transcrição de áudio (whisper + Gemini)
- O conector OAuth de contas IA

## O que muda
- O provedor de WhatsApp (Evolution API → Evolution GO)
- O formato do webhook recebido
- Os endpoints de envio de mensagem
- O QR code (endpoint diferente)

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Payload do webhook diferente | Adaptador isola o formato |
| Endpoints diferentes | Adapter traduz chamadas |
| Licença obrigatória do GO | Ativar antes de testar |
| Perda de mensagens na transição | Coexistência temporária |
| Número desconecta ao trocar | Testar com número piloto |
| Instabilidade do GO | Manter Evolution API como fallback |

---

## Cronograma estimado

| Fase | Tempo estimado |
|------|---------------|
| Fase 1 (instalação) | 1-2 horas |
| Fase 2 (adapter) | 3-4 horas |
| Fase 3 (webhook) | 2-3 horas |
| Fase 4 (teste piloto) | 1 hora |
| Fase 5 (migração gradual) | conforme volume |
| Fase 6 (desativação) | 30 min |

**Total código:** ~8-10 horas de implementação + testes.
