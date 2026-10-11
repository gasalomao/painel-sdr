# Quick Win — atualização com alvo explícito

O procedimento antigo por nome do agente foi substituído para impedir alterações em outros tenants.

## Antes de operar

Confirme tenant UUID e ID do agente pela sessão e projeto autorizados. Não descubra/lista outros tenants, não use nome como identificador e não execute SQL em banco real sem aprovação específica.

O script `migrations/quick_win_sarah_v2.sql` exige as configurações de sessão PostgreSQL `app.quick_win_client_id` e `app.quick_win_agent_id`. Valores ausentes, inválidos ou sem correspondência exata são rejeitados antes da alteração.

Após aprovação, configure os dois valores reais e revise o script. Ele trava um único agente, faz backup do prompt com tenant, revoga acesso público ao backup e atualiza somente esse alvo. Não deixe placeholders em comandos executados.

## Recuperação

Identifique explicitamente o ID do backup, tenant e agente. Use o modelo de rollback comentado no próprio script, que exige os três valores e verifica vínculo correspondente. Nunca selecione o último backup global nem todos os agentes com nome parecido.

## Evidência e limites

Três testes PGlite locais comprovam alvo obrigatório, isolamento entre agentes com mesmo nome e proteção do backup. Nenhuma atualização real, chamada de IA, envio a lead ou reinício de servidor foi executado durante esta validação.

Ganhos de conversão descritos nos documentos comerciais são projeções, não resultados medidos. Testes de negócio precisam de autorização separada, consentimento/opt-out e acompanhamento de métricas.

Referências: [prompt](PROMPT_SARAH_OTIMIZADO.md), [análise histórica](ANALISE_CONVERSAS_SARAH.md), [follow-ups](FASE_2_COMPLETA.md).
