# Correção: diagnóstico e retorno do backup

## Objetivo e critérios de aceite
- O botão de diagnóstico mostra imediatamente que o teste começou, impede cliques duplicados e termina com resultado ou erro junto ao botão.
- Diagnósticos têm histórico próprio no servidor, com data, verificações e resultado; não são apresentados como cópias do banco.
- Recarregar a página mantém os últimos testes e a última execução de backup, inclusive falhas. Nenhum dado de senha, token, URL de conexão ou stderr entra no histórico.
- A verificação confere ferramentas, versão/compatibilidade PostgreSQL e configuração necessária, sem dump, upload, exclusão, ativação de worker ou restauração.
- Ferramentas e requisições possuem prazo de execução. Indisponibilidade de schema/permissão é exibida explicitamente, nunca como sucesso.

## Implementação
1. API existente: separar leitura do histórico (GET) de execução (POST), com autorização administrativa e isolamento por `client_id`.
2. Tabela própria em `migrations/022_backup_diagnostics.sql`, incremental/idempotente, RLS somente servidor; aplicação em produção requer autorização separada.
3. Componente de diagnóstico na página existente, sem dependências novas; resultados e erros acessíveis na mesma área do botão.
4. Exibir a falha persistida independentemente da consulta de progresso; preservá-la ao atualizar o histórico e ler todas as páginas de eventos de execuções concluídas. Não recuperar automaticamente processos interrompidos.
5. O acompanhamento depende da identidade da execução, não da mudança de estado ativo/terminal, para não abortar o recarregamento final. Consultas terminais com erro não são repetidas automaticamente.

## Estrutura e convenções
- Backend: `src/lib/backup-diagnostics.ts`, `src/app/api/backup/diagnostics/route.ts`.
- Interface: `src/components/backup-diagnostics-panel.tsx`, `src/app/admin/backup/page.tsx`.
- Testes próximos aos módulos, Vitest + Testing Library existentes, integrações externas simuladas.
- Exemplo de limite público: `export async function GET(req: NextRequest): Promise<NextResponse>`; mensagens em português, sem `any` nem execução por shell.

## Verificação local
- `npx vitest run --config scripts/vitest-backup.config.ts` — suíte isolada, não carrega `.env` nem acessa serviços externos.
- `npx tsc --noEmit`
- `npx eslint src/app/admin/backup/page.tsx src/components/backup-diagnostics-panel.tsx src/app/api/backup/diagnostics/route.ts src/lib/backup-diagnostics.ts src/lib/backup-postgres.ts`
- Teste de interface em navegador local com respostas simuladas, sem sessão nem banco de produção.

### Evidência local em 19/10/2026
- Suíte isolada do backup: 71 testes aprovados, incluindo migration real em PGlite (banco local descartável), autorização, isolamento, falhas, timeout, compatibilidade de `pg_dumpall` e regressões do acompanhamento.
- Isolamento de ambiente: `envDir` temporário vazio confirmado por verificação executável; `setup.ts` não é carregado. A primeira configuração omitia o setup, mas ainda permitia a leitura automática de `.env` pelo Vite; não usá-la como prova de isolamento.
- Regressão ampla final com ambiente isolado: 2.416 testes aprovados, 31 testes live ignorados por opt-in; 138 arquivos aprovados e 18 ignorados. Inclui a correção de compatibilidade de `pg_dumpall`. Configuração temporária com `envDir` vazio, substituição de `dotenv` e credenciais fictícias locais; execução concluída em aproximadamente 184s. Não comprova integrações reais.
- A execução ampla anterior aprovou 2.411 testes, mas não isolava `envDir`; não serve como prova de ausência de leitura automática de `.env`.
- TypeScript sem erros e ESLint dos módulos/testes de backup sem erros/warnings. A página geral de configurações, alterada somente em textos de backup, tem 67 warnings existentes e zero erros. Build Next não executado nesta etapa; não assumir que essas verificações substituam o build do deploy.
- Chromium local: clique, estado de espera, resultado junto ao botão, histórico após reload e falha preservada ao atualizar o histórico aprovados; viewport de 375px sem overflow. APIs simuladas e CSS mínimo: não valida o tema final nem integrações de produção. Servidor temporário de QA encerrado.
- Revisão independente: corrigidos e cobertos por regressão os achados de falha oculta, leitura incompleta de eventos, isolamento do Vite e `pg_dumpall` antigo. Revisão de backend não identificou outros problemas obrigatórios de autenticação/tenant, sanitização, persistência, RLS ou timeout padrão.
- Tentativas anteriores: uma regressão ampla expirou em 120s e outra falhou na configuração temporária antes de coletar testes. Não tratar falha do harness como falha de todos os módulos.

## Limites
- Não commitar/push/deploy sem pedido explícito.
- Não ler segredos, aplicar SQL real, alterar EasyPanel, conectar ao PostgreSQL remoto/Google ou ligar agendamentos durante a correção.
- PostgreSQL interno do Supabase está no Compose `sistema/supabase`, serviço `db`; não confundir com outros Postgres da VPS. Host privado, versão e credenciais ainda não foram verificados.
- Drive conectado ao EasyPanel não autoriza o OAuth próprio do SDR.
- Diagnóstico aprovado não comprova upload nem restauração. Recuperação integral também depende dos arquivos físicos de Storage e das configurações da infraestrutura.
