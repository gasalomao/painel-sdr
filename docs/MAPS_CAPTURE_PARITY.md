# Paridade da captura Google Maps

## Objetivo e contrato

Prospecção Sites é a referência para todas as entradas de captura: captura manual, automação de prospecção, Captador Maps e Automação geral. Reutilizar o motor existente, sem outro scraper.

Critérios de aceite:
- Todos os formulários oferecem mínimo de **quantidade** de avaliações Google (não nota), somente com Instagram informado no Maps, remover sem telefone, duplicados, fixos e somente sem site.
- Mínimo inteiro de 0 a 2147483647; zero desativa. Valor inválido bloqueia envio com erro acessível, sem ligar comentários ou IA.
- Captura ampliada de avaliações é independente; resumo com IA é opt-in, com modelo e prompt. Ativar IA liga captura ampliada, como na referência.
- Captador envia `maxLeads` (padrão 50) ao mesmo motor da Prospecção; permite desligar o limite como a referência. Com meta positiva, continua/recomeça/expande abaixo da meta e conta somente leads aprovados e salvos. Pausa e parada explícitas continuam disponíveis.
- Automação mantém meta positiva e usa a retomada durável existente; não dispara abaixo da meta de leads elegíveis.
- Captador bloqueia configurações durante execução/pausa e libera após parada/fim. Na Automação, edição mostra filtros persistidos; captura já iniciada mantém bloqueio dos filtros/meta e preserva checkpoints do servidor mesmo depois de pausada. Defaults e configurações existentes não são reescritos silenciosamente.

## Implementação e estrutura

- `src/app/captador/page.tsx`: controles, validação e payload manual.
- `src/app/automacao/page.tsx`: controles, validação e criação/edição.
- `src/lib/scraper-review-count.ts`: parser de mínimo existente.
- `src/lib/scraper-engine.ts` e `src/lib/automation-worker.ts`: motor e retomada existentes, sem duplicação.
- `src/lib/__tests__`: testes de formulário/payload e regressões existentes de filtros, isolamento e continuidade.

O motor e o worker já implementam elegibilidade, persistência confirmada, novas tentativas e expansão. A lacuna era de formulário/payload; enviar `maxLeads` no Captador ativa a continuidade existente. Não criar outro motor ou duplicar os mecanismos de retomada. O padrão de 50 evita captura ilimitada acidental; a Automação preserva seu padrão de 100.

Manter React 19 / Next.js 16, componentes existentes, português, labels associados, erros com `aria-describedby` e `role="alert"`. Exemplo de contrato: `minReviews: 25, filterWithInstagram: true, filterWithWebsite: true, maxLeads: 50`.

## Ordem e verificação

1. Testes que reproduzem os campos/payloads ausentes.
2. Captador Maps: filtros e meta, depois avaliações/IA opt-in.
3. Automação: criar/editar, validação e bloqueio após início.
4. Regressões do motor compartilhado e verificação TypeScript/lint.

Comandos: `npm test -- src/lib/__tests__/captador-capture-options-ui.test.tsx src/lib/__tests__/automation-edit-runtime-ui.test.tsx`; `npm test`; `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=2` (suíte completa com menor concorrência); `npx tsc --noEmit`; `npm run lint`; `npm run build`.

## Evidências de verificação

- Resultado integral final (`--maxWorkers=2 --minWorkers=2`, sem build concorrente): **2992 testes aprovados, 31 ignorados e uma falha** no teste existente `src/app/admin/clientes/page.test.tsx:99` (`Unable to find role="menu"`), fora dos arquivos alterados. Não declarar suíte integral verde. Os testes de Captador (24) e Automação (28) passaram nessa execução. O arquivo de Administração de Clientes passou junto à Automação na execução isolada imediatamente anterior (35/35), sem alterações; a falha é intermitente e não foi corrigida neste escopo. A execução integral anterior à revisão passou com 2989 testes; outra concorrente com build teve timeout na Automação e a mesma falha de menu. Não usar essas execuções para ocultar o resultado final. A validação não usa captura Google Maps nem IA reais.
- `npm run build` compilou, verificou TypeScript e gerou as páginas estáticas. O gerador de setup SQL não deixou alterações em `src/lib/setup-sql.ts`.
- Lint dos quatro arquivos TypeScript deste ajuste: zero erros e 28 avisos preexistentes. O lint global sem filtros encontrou seis erros em dois scripts locais ignorados pelo Git (`.impeccable/capture-clientes.cjs` e `.impeccable/focus-clientes.cjs`), fora deste ajuste. Excluindo somente essa pasta, `node node_modules/eslint/bin/eslint.js . --ignore-pattern ".impeccable/**"` passou com zero erros e 1672 avisos existentes. Nenhuma configuração de lint foi alterada.
- Revisões em contextos separados: integração da Automação sem achados; Captador identificou falta de bloqueio das configurações durante execução/pausa e seleção obsoleta de modelo após falha ao recarregar. Quatro regressões reproduziram as falhas antes da correção e passaram depois; os dois arquivos do Captador passaram com 24 testes. Os controles agora ficam desabilitados durante captura/pausa e uma falha não abortada limpa a lista e a seleção de modelo. Uma nova revisão estática independente confirmou as duas correções sem achados.
- Navegador local com componentes reais e Header/Supabase/APIs simulados, acesso externo bloqueado: filtros e payloads do Captador e da criação de Automação verificados; bloqueio durante execução/pausa/SSE, desbloqueio após parada e rejeição de modelo obsoleto após falha confirmados. Sem overflow horizontal em 320, 768 e 1440 px e zero `pageerror`. Screenshots e roteiro reproduzível em `C:\Users\Salomão\AppData\Local\Temp\opencode\maps-parity-*`. Sem comparação com baseline visual ou alegação de teste de captura em produção.

## Limites

Sem dependências novas, migrations, commits ou chamadas reais de captura/IA. Não alterar regras de elegibilidade da Prospecção, isolamento por tenant, envio/webhooks nem disponibilidade dos dados no Google. A sessão manual usa memória e não ganha persistência após restart neste ajuste; automações usam os checkpoints existentes. Uma meta impossível permanece pendente, não vira conclusão falsa. Sem meta, mantém esgotamento normal da fila. Pós-filtros locais do Captador continuam apenas de visualização, não substituem os filtros aplicados antes de salvar.
