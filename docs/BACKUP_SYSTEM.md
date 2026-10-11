# Backup do PostgreSQL remoto para Google Drive

## Estado em 2026-10-11
Validação offline: 29 testes dos módulos backup-access/config/postgres aprovados; cada módulo tem 100% de linhas/statements/functions e pelo menos 94% de branches (Vitest V8). Esse recorte não cobre o fluxo integral de Google Drive/backup-service nem comprova restauração.

Deploy, migration real, upload e recuperação continuam NÃO executados. Não tratar pasta OAuth criada como prova de backup. Não há garantia de perda zero ou recuperação integral de VPS usando apenas pg_dump.

## Pré-requisitos
1. Aprovar e aplicar `migrations/020_backup_security_runs.sql` (incremental) no banco existente. Ela bloqueia acesso público aos tokens e cria fila/eventos. NÃO aplicar automaticamente nem recriar tabelas.
2. Configurar `DATABASE_URL` com usuário/senha PostgreSQL remoto e endpoint acessível em rede privada/túnel. A senha do painel Studio não é a senha PostgreSQL. O hostname Docker `db` não é acessível do Windows por padrão. O domínio HTTPS do Kong não demonstra acesso PostgreSQL a 5432.
3. Configurar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` e `NEXT_PUBLIC_APP_URL`. Redirect exato autorizado no Google Cloud. Publicar consentimento OAuth corretamente: aplicativos Google em modo Testing podem expirar refresh token em sete dias.
4. Configurar `BACKUP_TOKEN_KEY` com 32 bytes aleatórios em hex (64 caracteres), preservada fora da VPS. Sem chave não é possível migrar/conectar tokens.
5. Configurar `POSTGRES_BIN_DIR` se necessário. Windows procura instalações em Program Files/PostgreSQL; instalação 18 encontrada. Docker instala cliente Debian (15 no Bookworm): servidor mais novo exige imagem com cliente oficial compatível ANTES de ativar. Preflight impede dump com cliente antigo.
6. Após setup e permissões, ativar `BACKUP_WORKER_ENABLED=true` explicitamente no ambiente do servidor. Só funciona enquanto app Node está executando; servidores desligados não fazem cópias.

## Conteúdo do pacote único
`backup-<UTC>-<id>.tar.gz`, em `Backups Painel SDR/AAAA/MM/DD/`:
- `database.dump`: pg_dump custom, todos os schemas/tabelas/dados disponíveis ao usuário, funções, triggers, RLS, ownership e ACL. Novas tabelas/schemas entram no snapshot seguinte, sem cadastro manual.
- `globals.sql`: pg_dumpall globals, sem senhas de roles.
- `manifest.json`: versões, hashes SHA-256, escopo e exclusões; restorationTested=false até teste separado.
- `RECUPERACAO.txt`: limites e procedimento.

Não inclui arquivos físicos do Storage, volumes Docker, Edge Functions no filesystem, .env, chaves de Vault externas, senhas de roles, containers/Evolution ou outros serviços. Preservar estes separadamente para recuperação da infraestrutura. Mudanças posteriores ao começo do snapshot não entram nessa cópia; backup diário pode perder até o intervalo desde a última cópia. PITR/WAL é projeto separado.

## Painel
`Configurações > Backup > /admin/backup`. Somente administrador fora da personificação. Estado salvo separado das alterações pendentes. Histórico antigo não exibe mensagens que vazavam senhas. APIs não retornam tokens.
POST manual enfileira uma execução; worker consulta a cada minuto; painel consulta eventos reais a cada dois segundos. Eventos persistidos sobrevivem a reload. Stderr não contamina o arquivo, argumentos não contêm senha e processos não usam shell.

## Verificação e retenção
pg_restore --list verifica estrutura do dump; SHA-256 protege conteúdo local; MD5 e tamanho retornados por Drive precisam corresponder para confirmar envio. Não equivale a restauração já comprovada. Retenção só após cópia nova confirmada, apenas arquivos marcados pelo sistema e na raiz configurada; arquivo novo preservado. Deleção é permanente e exige retenção configurada pelo administrador. Não ativa/executa em produção durante desenvolvimento.

Fila possui exclusão global de queued/running e claim atômico. Execução interrompida NÃO é roubada automaticamente: pode existir subprocesso ainda ativo. Após crash, administrador precisa confirmar processo encerrado antes de marcar run failed; recuperação automática com fencing completo ainda pendente. Upload órfão pode existir após crash; manifesto e appProperties permitem identificá-lo no Drive independentemente do histórico.

## Recuperação sem o banco original
Baixe pacote no Drive, extraia em pasta nova/vazia. Nunca execute scripts de dentro de pasta não confiável.
`node scripts/restore-backup.mjs <pasta-extraída>` valida hashes e mostra instruções; NÃO conecta nem restaura automaticamente. Não se cola tar/custom dump no SQL Editor.
Prepare Supabase separado compatível, revise roles ausentes/extensões/configurações. pg_restore deve usar exit-on-error e transação, mantendo permissões/ownership. Objetos gerenciados do Supabase podem exigir procedimento específico. Só declarar recuperável depois de comparação real de dados, tabelas, sequences, RLS, ACLs, functions e login no destino descartável.

## Segurança e pendências
Credenciais expostas na conversa/guias/logs anteriores devem ser rotacionadas; não trocar todas as chaves Supabase unilateralmente porque isso afeta tokens/dados cifrados.
Migration real, env secreto, acesso Easypanel/SSH, rede PostgreSQL, teste de upload e restauração NÃO executados. Validação do fluxo integral, limites adicionais de rate limit, SSE/resumable upload e crash-recovery completo continuam pendentes antes de produção. Os módulos de autorização/configuração/subprocesso foram testados offline; isso não autoriza operação no banco real. Não afirmar pronto sem esses gates.
