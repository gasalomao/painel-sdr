# Chat: estabilidade do CRM e sugestões de tags

## Contrato

- Alterar tags, nome, foto ou anotações do mesmo contato não reinicia a consulta CRM nem apaga a etapa atual. A consulta depende da identidade e empresa, não do objeto completo ou sessão.
- Trocar contato/empresa descarta respostas antigas. Reabrir a sidebar e tentar novamente continuam consultando o estado atual.
- A API aceita funis antigos sem `kanban_columns.is_terminal`, preserva o indicador quando existe e não converte falhas reais em ausência de lead/defaults.
- Contatos transitórios com ID que não é UUID usam telefone/JID; UUID persistido continua validado e resolvido no servidor por tenant.
- Ao digitar parte do nome, sugerir tags existentes nos contatos da mesma empresa, ignorando maiúsculas e acentos na busca. Selecionar com mouse ou teclado vincula imediatamente; texto livre continua criando tags.
- Não sugerir tags já vinculadas. Evitar escrita duplicada, preservar entrada e tags em erro, isolar carregamentos e callbacks ao trocar contato/empresa.
- Catálogo deriva de `contacts.tags`, paginado e autenticado. Não há tabela independente: tag sem nenhuma associação deixa de constar no catálogo.
- Preservar correções e visuais locais. Sem migration, dados reais, serviços pagos, commit ou publicação.

## Sequência e verificação

1. Reproduzir incompatibilidade SQL e consultas redundantes com regressões; corrigir sem mudar resolução segura de identidade.
2. API de leitura do catálogo, paginação, isolamento, erro e deduplicação; autocomplete acessível usando dependência instalada.
3. Testar seleção, texto livre, erros, concorrência e troca de contexto; navegador com fixtures sintéticas; suíte, TypeScript, lint e build.

## Evidência inicial

- `ContactSidebar` serializa todo o contato em `crmSelection` e usa `[contact]` no efeito CRM. O callback de tags/anotações troca essa referência no pai.
- A migration `001_multi_tenant.sql` não contém `is_terminal`; o setup consolidado contém, mas `CREATE TABLE IF NOT EXISTS` não atualiza tabelas existentes. Reproduzido offline: seleção explícita retorna PostgreSQL `42703` e HTTP 500, inclusive com lead vinculado válido. Não confirma o esquema atualmente em produção.
- As queries antigas de tags/anotações filtram só por ID; neste fluxo devem também filtrar empresa e confirmar linha afetada.

## Implementação e regressões locais

- Consulta CRM usa somente empresa e identidade estável. IDs transitórios são enviados como telefone/JID; contatos UUID continuam resolvidos no servidor.
- `readColumns` lê colunas existentes e projeta apenas `status_key`, `label` e `is_terminal === true`. Falhas reais continuam sendo erros, sem fallback silencioso para ausência de lead.
- Catálogo `/api/contacts/tags`: autenticação, empresa obtida da sessão, paginação de 500 contatos, nomes limpos/deduplicados/ordenados e `Cache-Control: no-store`. Sem tabela nova ou migration.
- Autocomplete usa Base UI já instalado, busca por trecho sem acentos, seleção por clique/teclado e texto livre. Popup fecha sem correspondências e ao iniciar escrita; o gerenciador de foco da biblioteca oculta controles externos da árvore de acessibilidade enquanto o popup está aberto, inclusive com `modal={false}`.
- Tags e anotações filtram `id` e `client_id`, confirmam linha atualizada e descartam callbacks de contexto desmontado. Callbacks mesclam o contato mais recente, preservando campos salvos concorrentemente. Rascunhos de notas não são apagados por tags nem pelo término de um salvamento anterior.
- API CRM: RED com schema legado confirmado; **23 testes passaram**. Catálogo: RED por rota ausente confirmado; **13 testes passaram**.
- Sidebar: falhas iniciais de acessibilidade reproduzidas e corrigidas; 8 novas regressões de concorrência encontraram 5 falhas antes da correção. **24 testes passaram** nessa etapa. Uma regressão adicional confirmou que vincular lead podia sobrescrever tags/notas recentes; callback corrigido para mesclar o contato atual.
- Revisão independente das APIs/helper: **52 testes passaram**, sem bloqueios. Lacunas não bloqueantes: erro/ambiguidade entre páginas do resolvedor e repetição do POST após falha no vínculo de lead recém-criado.
- Sidebar final nesta etapa: **27 testes passaram**, incluindo nome canônico do catálogo, bloqueio de duplicidade sem diferenciar maiúsculas e preservação de entrada após erro de escrita. Junto às duas APIs: **63 testes passaram**.
- Primeira suíte geral: **2.931 passaram, 1 falhou, 31 ignorados**. Falha em `agent-page.test.tsx` aguardando a aba carregada sob demanda; os 4 testes desse arquivo passaram isoladamente. Reexecução serial: **2.932 passaram, 31 ignorados**, sem falha; as duas regressões adicionais de tags passaram na execução direcionada posterior.
- `npm run build` e `npx --no-install tsc --noEmit`: aprovados. Primeiro lint geral parou em 2 erros de mutação durante render na fixture sintética de QA, não em código da aplicação; registros movidos para `useEffect` e lint direcionado da fixture aprovado. Nova execução geral aprovada, detalhada abaixo. Lint direcionado das APIs/sidebar sem erros (2 avisos preexistentes: `any` no agente de IA e `<img>`).
- Revisão independente da sidebar encontrou popup reabrindo após catálogo atrasado com foco já nas anotações; reprodução RED confirmou `aria-expanded=true` indevido e anotação sob `aria-hidden`. O `onBlur` agora cancela a intenção ao sair do input/popup. Dois testes novos cobrem foco dentro/fora: **29 testes da sidebar passaram**. Reavaliação independente confirmou o Required resolvido, seleção por teclado e reabertura preservadas, sem novos bloqueios; touch físico não foi validado.
- QA inicial encontrou fundo transparente no portal; `Positioner` recebeu `styles.portal`, preservando os tokens locais do chat. **QA final: 17/17 cenários novos + 22/22 regressões legadas passaram**, em 320/375/768/1440 px, sem erros JavaScript/console ou overflow. Catálogo atrasado com foco dentro/fora validado nos quatro tamanhos. Fundo opaco confirmado por screenshot e estilo computado `rgb(30, 38, 32)`; nenhuma pendência visual do escopo. Evidências: `.impeccable/fixes-qa/results/crm-tags.json`, `crm-tags-report.md`, `crm-tags-themed-suggestions-320.png` e `crm-tags-deferred-notes-320.png`. Sem comparação pixel a pixel por ausência de baseline.
- **Verificação geral final após os ajustes de foco/tema:** `npm test -- --maxWorkers=1 --minWorkers=1`: **2.936 passaram, 31 ignorados**, 161 arquivos aprovados/18 ignorados. `npm run build`, `npx --no-install tsc --noEmit` e `npm run lint`: **exit 0**. Lint geral contém 1.695 avisos existentes, sem erros. `git diff --check` direcionado sem erros.

## Publicação autorizada

Após a validação local, o usuário solicitou o envio ao GitHub para deploy. Essa autorização substitui a restrição inicial de commit/publicação, sem autorizar migrations, alterações manuais em dados reais ou inclusão de segredos e artefatos locais de QA. O push em `main` aciona o deploy automático no EasyPanel; confirmar o push não equivale a confirmar a conclusão do deploy.

## Fora deste ajuste

- Atribuição de agente de IA já escrevia sem `client_id`, confirmação de linha afetada ou descarte após troca de sessão. Não foi alterada aqui; revisão independente a registrou separadamente como dívida preexistente.

## Limites

A incompatibilidade de schema foi reproduzida offline; não foi consultado o schema de produção nem confirmado o erro autenticado do contato relatado. Sem dados reais, migration, commit ou publicação.
