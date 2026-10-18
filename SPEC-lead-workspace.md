# Spec: lead-workspace

Status: proposta para revisão. Módulo do CAPABILITY-MAP.md aprovado em 18/10/2026.

## Objetivo

Transformar a ficha do lead em uma área de trabalho legível e prática: reconhecer o contato, consultar o contexto comercial e registrar o próximo passo sem perder a posição no quadro.

## Experiência e critérios de sucesso

1. Cabeçalho com nome, telefone, etapa e foto de perfil quando disponível; ausência de foto usa iniciais discretas, nunca uma imagem genérica de pessoa.
2. Ação principal para abrir a conversa; ações secundárias para copiar telefone e consultar links válidos de WhatsApp, Maps, site e redes sociais existentes.
3. Dados agrupados por assunto: contato, negócio/localização e contexto comercial. Mostrar somente dados reais disponíveis; campos ausentes não recebem valores inventados.
4. Anotações internas editáveis, com confirmação explícita de gravação, estado de salvamento e erro em português. Falha não descarta o texto digitado. Preservar anotações anteriores.
5. Histórico cronológico carrega sob demanda, limitado e paginado, aproveitando atividades existentes; não simular eventos que nunca foram registrados.
6. Próxima ação tem posição de destaque e usa o contrato de lead-reminders quando esse módulo estiver disponível.
7. Cartão do Kanban concentra nome/foto, contato e contexto essencial; informações extensas ficam na ficha. Preservar clique para detalhes e ações secundárias sem iniciar arraste.
8. Abrir e fechar a ficha mantém filtro, rolagem e posição no quadro. Mudanças salvas atualizam ficha, cartão e lista sem recarregar a página inteira.
9. Ficha utilizável em 375 px e desktop: cabeçalho e ações acessíveis, conteúdo com rolagem, foco visível, rótulos e navegação por teclado; Escape respeita edição não salva.
10. Continuam funcionando os testes do arraste: destinos vazios/ocupados, mouse, toque, teclado, cancelamento, concorrência, rollback e drop fora do quadro.

## Contratos de integração

- A identidade é o par lead.id/client_id validado no servidor. IDs enviados pelo navegador nunca conferem autorização.
- lead-reminders associa registros ao lead existente e devolve um resumo limitado da próxima ação, sem carregar todo o histórico no quadro.
- lead-whatsapp-photos fornece URL/estado da foto; carregar a ficha ou o quadro não deve provocar uma chamada externa por cartão.
- Preferir estruturas e rotas existentes para notas, atividades e conversas. Novas tabelas ou alterações de schema dependem de revisão explícita.

## Stack e estrutura

Next.js 16.3.1, React 19.2.4, TypeScript 5, Tailwind 4, Supabase, componentes UI existentes e Vitest 2.1.9.

- Interface: src/app/leads/page.tsx e src/app/leads/_components/.
- APIs: src/app/api/; regras e clientes compartilhados em src/lib/.
- Tipos: src/types/; regressões em src/lib/__tests__/.
- Documentação técnica: docs/; schema versionado em migrations/ somente quando aprovado.

## Comandos

- Desenvolvimento: npm run dev
- Testes focados: npm run test -- src/lib/__tests__/kanban-board.test.tsx
- Suíte offline: npm run test -- --maxWorkers=2 --minWorkers=1 --hookTimeout=60000
- Tipos: npx tsc --noEmit
- Lint: npm run lint
- Build: npm run build

## Estilo

Preservar padrões existentes, UI em português, sem any, tipos explícitos em funções exportadas. Manter componentes interativos pequenos e reutilizar o cliente Supabase existente.

```ts
export function getLeadDisplayName(name: string | null): string {
  return name?.trim() || "Lead sem nome";
}
```

## Testes

Vitest e Testing Library para abertura/fechamento, campos ausentes, edição/gravação/erro, troca rápida de lead sem dados obsoletos e atualização do estado do pai. Testes de API para autorização, isolamento e entradas inválidas. QA offline em navegador com dados sintéticos, desktop e celular; registrar separadamente o que não foi verificado em ambiente real.

## Limites

- Sempre: validar entradas, filtrar por client_id, limitar leituras, preservar alterações locais anteriores e apresentar erros honestos.
- Pedir antes: nova dependência, mudança de schema, commit, acesso de teste a serviços externos ou dados reais.
- Nunca: aplicar migration em banco real, publicar, enviar mensagens ao lead, expor segredos, inventar histórico ou substituir a correção do Kanban.

## Fora do escopo

Novo mecanismo de pontuação por IA, anexos, editor rich text, mudança global de identidade visual e implantação de outro CRM.

## Referências consultadas

- Pipedrive, Detail view: https://support.pipedrive.com/en/article/detail-view — reunir dados, atividades e notas no contexto do contato.
- HubSpot, Create or log activities on a record: https://knowledge.hubspot.com/records/manually-log-activities-on-records — ações rápidas e histórico associado ao registro.
- The Kanban Guide, maio/2025: https://kanbanguides.org/the-kanban-guide/2025.5/ — visualizar fluxo e identificar itens envelhecendo. Não exibir tempo na etapa sem eventos confiáveis que sustentem o cálculo.
- Guias instalados do Next.js: node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md e 15-route-handlers.md.

## Levantamento técnico

Detalhes de reutilização e arquivos de implementação serão consolidados a partir do levantamento do código antes do plano.
