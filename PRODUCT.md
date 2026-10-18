# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operadores de prospecção e atendimento que acompanham leads, conversas no WhatsApp e retornos comerciais no painel SDR.

## Product Purpose

Reunir as informações necessárias para identificar um lead, entender seu histórico e executar a próxima ação sem alternar entre telas desnecessariamente.

## Operating Context

Aplicação existente Salomão AI, multi-tenant, com quadro de leads, dashboard, conversas e integrações de WhatsApp. Textos da interface em português. Uso pelo navegador, incluindo telas móveis.

## Capabilities and Constraints

- Escopo aprovado em 18/10/2026: ficha profissional com anotações e histórico, lembretes internos e fotos de perfil do WhatsApp com sincronização eficiente.
- Lembretes aparecem no painel, incluindo dashboard e notificações internas. Não há compromisso de aviso externo com o painel fechado; pendências precisam reaparecer ao retornar.
- Fotos devem usar cache e sincronização em lotes; não armazenar arquivos de imagem no banco de dados.
- Reaproveitar integrações e dados existentes antes de criar novas estruturas.
- Preservar isolamento entre clientes, funcionalidades atuais e correção local do arraste do Kanban.
- Trabalho local: sem commit, publicação ou aplicação de migration em banco real sem autorização explícita.

## Brand Commitments

Preservar a identidade do painel existente e a marca Salomão AI. Não se trata de uma reformulação global do produto.

## Evidence on Hand

- Código e documentação do projeto existente.
- Solicitação de melhoria da ficha e dos cartões de lead, com anotações, lembretes e foto do WhatsApp.
- Aprovação das três partes e escolha de notificações somente no painel.
- Exemplos visuais e dados de teste não são prova de clientes, resultados comerciais ou funcionamento em produção.

## Product Principles

1. Mostrar identidade, contexto e próxima ação antes de detalhes secundários.
2. Facilitar consulta e execução sem sobrecarregar cartões ou navegação.
3. Manter baixo o custo de consulta, sincronização e armazenamento.
4. Não inventar informações ausentes nem confundir falha técnica com dado inexistente.
5. Preservar segurança multi-tenant e comportamento existente.
