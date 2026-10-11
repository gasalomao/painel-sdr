# Backup — estado de validação

Este relatório antigo foi substituído por [docs/BACKUP_SYSTEM.md](docs/BACKUP_SYSTEM.md).

O código de autorização, tokens e subprocessos tem validação offline. Isso não comprova conexão com PostgreSQL remoto, upload ao Google Drive, execução de migration ou recuperação funcional.

A cópia representa um snapshot dos objetos acessíveis ao usuário PostgreSQL. Não inclui Storage físico, volumes/containers, segredos externos nem mudanças posteriores ao snapshot. Não há garantia de perda zero ou restauração da VPS inteira.

Restauração sobre o banco em uso está bloqueada. Recuperação exige destino separado, versões/extensões compatíveis, revisão das roles e aprovação específica. Consulte o documento canônico antes de operar.
