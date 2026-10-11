# Backup — guia substituído

Este guia descrevia uma implementação anterior e não deve ser usado para configurar ou restaurar o sistema atual.

Consulte [Backup do PostgreSQL remoto](docs/BACKUP_SYSTEM.md) para requisitos, limites e estado verificado.

- O pacote atual é `.tar.gz`, com dump PostgreSQL custom, roles sem senhas e manifesto de checksums.
- Restauração sobre o banco em uso está bloqueada. Teste somente em destino separado, com aprovação específica.
- Storage físico, volumes da VPS e segredos de infraestrutura não estão incluídos. Não existe garantia de perda zero.
- Migration, conexão/upload reais e recuperação não foram executados durante a validação offline.
- Exemplos devem usar `https://seu-painel-supabase.example`, nunca hostnames operacionais privados.
