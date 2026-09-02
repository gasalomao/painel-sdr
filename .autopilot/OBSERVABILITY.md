# Observability

Status: `TODO`.

## Correlação-alvo

`request_id`, `client_id`, `user_id`, `session_id`, `agent_id`, `message_id`, `job_id`, `campaign_id`, `target_id`, `provider`, `model`, `attempt`.

## Dados proibidos

Passwords, headers de autorização, cookies completos, API keys, OAuth refresh tokens e PII/prompt sem política explícita.

## Sinais prioritários

Requests/errors/latency; webhooks aceitos/rejeitados; jobs pendentes/idade/retries/dead; lag de campanha/follow-up/agenda; timeout/failover/supressão/tool failure de IA; erros de provider e duração do scraper.

Implementação será mínima e compatível com logs atuais antes de introduzir plataforma externa.
