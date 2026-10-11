# Backup — escopo e limites

Este guia antigo continha garantias que a implementação não oferece. A documentação vigente é [docs/BACKUP_SYSTEM.md](docs/BACKUP_SYSTEM.md).

O pacote atual `.tar.gz` contém dump PostgreSQL custom, globals sem senhas, manifesto de hashes e instruções. Inclui os objetos/dados disponíveis ao usuário da exportação no instante do snapshot, conforme permissões e compatibilidade do servidor.

Não inclui Storage físico, volumes da VPS, containers, serviços externos ou segredos de ambiente. Backup periódico pode perder alterações desde o último snapshot; não substitui PITR/WAL.

Checksums e `pg_restore --list` não comprovam recuperação funcional. Não existe restauração com um clique sobre produção nem garantia de perda zero. Valide em Supabase separado e compatível, com aprovação específica, antes de declarar recuperável.
