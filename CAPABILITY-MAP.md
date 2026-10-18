# Capability Map: CRM de leads

Escopo aprovado pelo usuário em 18/10/2026. Implementação local; sem commit, deploy ou migration em banco real.

| Module id | Responsabilidade | Depende de |
|---|---|---|
| lead-workspace | Ficha profissional, dados de contato e comerciais, anotações e consulta de histórico; preservar o Kanban corrigido. | — |
| lead-reminders | Lista de tarefas livres ou por lead, texto e vencimento, check de conclusão/reabertura, histórico e destaque por proximidade na Dashboard. Ampliação aprovada pelo usuário; lembretes legados preservados. | lead-workspace |
| lead-whatsapp-photos | Foto de perfil do WhatsApp na ficha e cartões, sincronização individual/em lotes com cache e isolamento entre clientes. | lead-workspace |

Ordem de construção: lead-workspace; depois lead-reminders e lead-whatsapp-photos.

## Limites confirmados

- Lembretes somente dentro do painel. Com o painel fechado, permanecem pendentes para o próximo acesso; não há push, email ou WhatsApp de lembrete neste escopo.
- Fotos armazenadas como referência/cache, não como arquivos binários no banco.
- Identidade atual do painel preservada. Não redesenhar outros módulos.
- Especificações por módulo: SPEC-lead-workspace.md, SPEC-lead-reminders.md e SPEC-lead-whatsapp-photos.md, a produzir após concluir o levantamento do código.
