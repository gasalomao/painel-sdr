# Backup do Supabase para Google Drive no EasyPanel

Pesquisa em documentação oficial: 19/10/2026. Este guia não confirma que a VPS esteja configurada. Nenhuma restauração deve ser feita no banco de produção para testar um backup.

## Primeiro: identificar a instalação

1. Abra o EasyPanel e entre no projeto que contém o Supabase.
2. Encontre o serviço do Postgres. Ele pode estar separado dos demais componentes do Supabase ou dentro de um serviço Compose.
3. Confira se esse serviço tem a aba **Backups**.
4. Se não conseguir identificar, envie uma captura com os nomes dos serviços e as abas. Não inclua variáveis de ambiente, senhas, tokens, strings de conexão ou QR codes.

Estar na mesma VPS facilita a conexão interna, mas `localhost` dentro do container do painel SDR aponta para ele próprio, não para o Postgres. Não abra a porta do Postgres na internet só para realizar backup.

## Caminho mais simples: integração nativa do EasyPanel

Use este caminho se o Postgres for um serviço de banco gerenciado pelo EasyPanel e apresentar a aba **Backups**. O agendamento depende de uma licença que inclua backups agendados; confirme na instalação.

### 1. Conectar o Google Drive

Na documentação atual, o caminho é **Settings → Server → Storage Providers → Add Provider → Google Drive**. Nomes podem variar conforme versão/idioma do EasyPanel.

1. Dê um nome ao destino, por exemplo `Drive - backups Supabase`.
2. Salve e autorize no navegador usando a conta Google que guardará os backups.
3. Confirme que o destino está conectado.
4. Não compartilhe a pasta com “qualquer pessoa com o link”. Ative verificação em duas etapas na conta Google.

A autorização é feita por você no Google; não envie token ou senha pelo chat.

### 2. Configurar o banco

No serviço Postgres, abra **Backups → Create Database Backup**:

| Campo | Orientação |
| --- | --- |
| Database | Confirmar o banco usado pelo Supabase; costuma ser `postgres`, mas não assumir sem conferir. |
| Enabled | Ativar depois de preencher e testar. |
| Schedule | `0 3 * * *` significa 03:00 no fuso do servidor. Conferir o fuso antes. |
| Retention | Sugestão inicial: 14 cópias; ajustar conforme tamanho e espaço no Drive. |
| Provider | A conexão Google Drive autorizada. |
| Destination | Uma pasta exclusiva, por exemplo `Backups_Supabase/producao/database`. |

**Importante:** a retenção nativa considera todos os arquivos da pasta configurada. Não use essa mesma pasta para documentos pessoais, outros bancos ou volumes.

### 3. Verificar um backup real

1. Abra as ações da configuração e escolha **Manual Run**.
2. Aguarde o término e confira **Backups Log**. Iniciar não significa concluir.
3. Abra o Google Drive e confirme o arquivo novo, seu horário e tamanho.
4. O Postgres nativo do EasyPanel gera um dump em formato custom, envolto em gzip, com extensão `.sql.gz`. A extensão não significa que seja SQL texto; a recuperação exige o formato correto.
5. No dia seguinte, confira se houve uma execução automática. Repita a verificação periodicamente e monitore espaço e autorização do Google.

Não trate a configuração como recuperação validada antes de restaurar uma cópia em ambiente isolado com versões/extensões compatíveis.

## Se o Supabase estiver em App/Compose e não houver Backups

Não adapte nomes de container por tentativa. Primeiro identifique a instalação e o mecanismo de backup já existente na aplicação.

Opções possíveis após identificar a instalação:

- Aproveitar a interface de backup do painel SDR, desde que haja conexão Postgres direta, ferramentas de dump no container e Google Drive autorizado.
- Usar uma rotina na VPS com ferramentas do próprio container Postgres e upload ao Drive. Ela deve falhar explicitamente em erros de dump/compressão/upload, usar nomes únicos, permissões restritas, lock contra sobreposição, verificação de integridade e política de retenção limitada à sua pasta.

Não monte `/var/run/docker.sock` no painel SDR para contornar a rede. Esse socket pode dar ao aplicativo controle administrativo sobre a VPS inteira.

## O que precisa estar protegido

| Parte | Um dump do banco cobre? | Ação |
| --- | --- | --- |
| Tabelas, dados, índices, funções, triggers e políticas RLS | Conforme escopo e permissões do dump | Preferir backup lógico completo do banco, não exportação de uma lista fixa de tabelas. |
| Usuários e objetos internos do Supabase | Só se os schemas correspondentes estiverem incluídos e acessíveis | Confirmar escopo e testar login na cópia restaurada. |
| Roles globais e configurações do cluster | Não pelo `pg_dump` de um banco isolado | Planejar preservação/recriação segura; não aplicar `pg_dumpall --clean` no cluster de produção. |
| Fotos, anexos, documentos e outros objetos do Supabase Storage | **Não**; o banco guarda metadados, não os arquivos | Backup separado do volume ou do backend S3. |
| Variáveis de ambiente, chaves, arquivos Compose e Edge Functions | **Não** | Guardar uma cópia protegida fora da VPS. Nunca no GitHub ou em pasta pública do Drive. |
| Volumes de outros serviços, como Evolution | **Não** | Avaliar separadamente se precisam de recuperação. |

O espelhamento de volumes do EasyPanel usa `rclone sync`: exclusões na origem podem excluir a cópia no destino. Não é um histórico de snapshots. Nunca copiar o diretório de dados de um Postgres em execução como substituto de um backup consistente do banco. Bind mounts também precisam de plano separado.

Backups podem conter dados de todos os clientes, hashes de senhas e credenciais de integrações. Devem ficar restritos a administradores autorizados. Defina retenção e, para maior proteção, criptografia antes do upload, com a chave de recuperação guardada separadamente. Gzip comprime, mas não criptografa.

## Correções no tutorial recebido

- A integração nativa com Google Drive existe, mas na documentação atual fica em **Storage Providers**, não necessariamente em **Settings → Backups → Rclone**.
- Agendamento nativo depende da licença e do tipo de serviço; um Supabase em Compose não deve ser tratado automaticamente como serviço Postgres do painel.
- `pg_dumpall ... | gzip` sem `pipefail` pode produzir um gzip válido de conteúdo vazio/incompleto enquanto o comando parece bem-sucedido. `gzip -t` sozinho não comprova que o dump foi concluído.
- `docker ps ... | head -n 1` pode escolher o banco errado. Nomes dos containers podem mudar no redeploy. Não é uma seleção segura sem validação do serviço.
- Reutilizar `backup.sql.gz` sobrescreve o único ponto de recuperação. O nome deve incluir data/hora e evitar colisões.
- A rotina recebida não contempla retenção, controle de concorrência, criptografia, alertas, espaço em disco, falhas de upload ou ensaio de recuperação.
- A configuração do rclone pode conter refresh tokens. Não colar sua saída aqui nem commitar esse arquivo.
- A documentação atual do rclone avisa sobre a retirada do client ID compartilhado durante 2026: não pressupor que deixar `client_id`/`client_secret` vazios funcione de forma duradoura.
- Em uma integração OAuth própria com Drive, um app Google externo em **Testing** emite refresh tokens com validade de sete dias para esses escopos. Preparar o status adequado antes de depender do agendamento e reconectar se necessário.

## Critério de conclusão

- [ ] Banco e instalação corretos identificados.
- [ ] Conta Google autorizada e pasta exclusiva privada.
- [ ] Backup manual concluído sem erros; arquivo conferido no Drive.
- [ ] Escopo documentado (banco completo versus exportação parcial).
- [ ] Estratégia de Storage e configuração definida.
- [ ] Fuso, horário e retenção conferidos.
- [ ] Execução automática posterior comprovada.
- [ ] Restauração em ambiente isolado validada com dados, RLS, autenticação e arquivos relevantes.
- [ ] Monitoramento de falhas e espaço disponível definido.

Até esses itens serem verificados, o status correto é **configuração em andamento**, não “backup garantido”.

## Fontes oficiais

- EasyPanel — destinos: https://easypanel.io/docs/backups
- EasyPanel — Google Drive: https://easypanel.io/docs/storage-providers/google-drive
- EasyPanel — banco, licença, retenção e formato: https://easypanel.io/docs/backups/database
- EasyPanel — limitações de backup de volumes: https://easypanel.io/docs/backups/volumes
- Supabase — instalação e volumes: https://supabase.com/docs/guides/self-hosting/docker
- Supabase — conexão direta para `pg_dump`: https://supabase.com/docs/guides/self-hosting/accessing-postgres
- Supabase — arquivos Storage fora do dump: https://supabase.com/docs/guides/platform/backups
- PostgreSQL — formatos e limites do dump: https://www.postgresql.org/docs/current/app-pgdump.html
- Google — validade dos refresh tokens: https://developers.google.com/identity/protocols/oauth2#expiration
- rclone — Google Drive e client ID próprio: https://rclone.org/drive/
