# Pendências para o painel-sdr estar pronto para produção

Atualizado em 2026-09-03. Estado dos gates locais **agora**: lint 0 erros, typecheck 0, 746 testes passando (31 live puladas), `npm run build` exit 0.

## Ação URGENTE antes ou logo depois do deploy — rotação de segredos

O histórico do git contém credenciais reais (JWT_SECRET, chaves Supabase anon/service, AUTH_SECRET, senhas de Evolution/Redis/Admin/Postgres/Studio). O arquivo `DEPLOY-SEGURANCA.md` foi sanitizado, mas **os valores antigos continuam no histórico**. Tratar como comprometidos:

1. Rotacionar `JWT_SECRET` no Supabase e regenerar `ANON_KEY` / `SERVICE_ROLE_KEY`.
2. Rotacionar `AUTH_SECRET`, `ADMIN_PASSWORD`, `DASHBOARD_PASSWORD`.
3. Rotacionar `EVOLUTION_API_KEY`, `EVOLUTION_GO_KEY`, `REDIS_PASSWORD`.
4. `POSTGRES_PASSWORD`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`: trocar só com plano de migração (quebra volume se trocar só a env).
5. Depois de tudo rotacionado e funcionando, limpar o histórico (BFG/git filter-repo) se o repositório for público em algum momento.

## Ações no banco de produção (irreversíveis sem manutenção agendada)

1. Executar `migrations/SETUP_COMPLETO.sql` em um banco vazio ou confirmar que o schema já bate (gerador `scripts/build-setup-sql.mjs` == origem canônica de verdade; `src/lib/setup-sql.ts` é gerado).
2. Executar `migrations/015_leads_remotejid_multi_tenant.sql` (resolver nulos/duplicatas de `remote_jid` antes — o preflight do script falha com lista de conflitos, o que é o comportamento desejado).
3. Aplicar `HARDEN_RLS.sql` (RLS + REVOKE) e comprovar com introspecção SQL (`pg_policies`, `tablename`, permissões de `anon`). Sem isso, vários achados de isolamento dependem só do código da aplicação.
4. Provisionar `webhook_secret` por instância em `channel_connections.provider_config` (Evolution/GO). Sem secret, instância continua forjável por design (opt-in `webhook_strict=false` é só migração).

## Falhas de design que ainda faltam corrigir (por prioridade)

### Alta
- **Cascata de campanhas e workers em réplicas** — `src/instrumentation.ts` inicia timers locais; sem lease distribuído, 2+ réplicas enviam o mesmo target. Bugs desta categoria já causam pausas fail-closed — operação has manual. Definir: leader election por banco (advisory lock) ou BullMQ exclusivo.
- **Feature gates só no front** — APIs ignoram assinatura/plano (proxy só para páginas). Médio-alto de abuso.
- **`/api/admin/*` depende 100% do middleware** — sem auth no handler; qualquer bypass de proxy expõe tudo.
- **Rate limit de login in-memory** — resetável reiniciando a réplica; `x-forwarded-for` spoofável sem confiança de borda configurada.
- **Upload de mídia** — 100MB em memória, bucket público, extensão pelo nome do arquivo.

### Média
- SEC-H5: `isSessionLive` fail-open em session/change-password — revisar se conveniência justifica.
- SEC-H6: segredo único (`AUTH_SECRET` com fallback pra `SUPABASE_SERVICE_ROLE_KEY`) assina sessão, internal-auth, OAuth state e DeepSeek bearer — separar por uso.
- SEC-M11: OAuth `state` com HMAC mas sem consumo de nonce (replay).
- SEC-M12: `serviceRole` por querystring em `setup-db`.
- SEC-M15 residual: `fetchPublicHttpUrl` valida DNS antes do fetch mas não pina o IP (janela TOCTOU/rebinding; mitigar com egress proxy ou fetch com IP pinado + Host).
- SEC-M16: sem CSP/HSTS/X-Frame-Options em `next.config.ts`.
- SEC-M18: canais Realtime sem filtro `client_id`.
- PBKDF2 100k (OWASP sugere 600k); JWT sem iss/aud; TTL 30d sem idle timeout.
- `xlsx@0.18.5` com advisory — uso só export; trocar quando possível.

## O que já foi fechado nesta rodada (não refazer)

- Impersonação admin revoga/reemite sessão; cookie legado não restaura admin — 7 testes.
- Knowledge base com ownership e filtros `client_id` — 5 testes.
- Webhooks Evolution/GO fail-closed (401) quando há secret configurado; `webhook_strict=false` é opt-out explícito. HMAC Cloud valida secret pelo `phone_number_id` da conexão (sem segredo emprestado) — 3 testes novos.
- Scraper isolado por (clientId, automationId); SSE por tenant; owner fail-closed.
- Campanhas: sends com `ok:false` como falha real; recovery pós-crash pausa campanha com targets ambíguos em vez de reenviar; reserva CAS — teste novo.
- Follow-up: claim atômico por (current_step,status) e validação de dono pós-envio; 49 testes.
- Appointments: claim com `reminders_sent` snapshot; rollback CAS.
- `persistOutgoingMessage` fail-closed por tenant; upserts com conflito `(client_id, message_id)`.
- Avatares e sync JID compostos por tenant; diagnósticos fail-closed; `send-message` sem bypass admin e com scoped updates — testes de isolamento.
- Whatsapp Cloud resolve conexão por `phone_number_id` → mensagens/updates sempre com `client_id`; `webhook_logs` escopados.
- SQL canônico regenerado de migrations; o drift `openrouter_keys`/`ai_combos` reconciliado — 3 testes do gerador.

## Validação final desta rodada

`npm run lint`: 0 erros (1.6k warnings legacy) • `npx tsc --noEmit`: 0 • `npm run test`: 746 pass / 31 live puladas • `npm run build`: exit 0 • `git diff --check`: limpo.

## Pronto para deploy?

**Sim, com ressalvas.** O código está mais seguro e os gates passam, **mas o deploy carrega riscos residuais**: (a) a aplicação ainda injeta timers in-process — rode **1 réplica** até resolver o lease; (b) o passo de banco acima é obrigatório para a lista de constraints compositivas; (c) faça a rotação de segredos na mesma manutenção. Sem isso, o painel segue operável porém com isolamento garantido só por aplicação.
