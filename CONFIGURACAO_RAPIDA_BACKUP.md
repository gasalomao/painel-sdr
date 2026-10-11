# Configuração de backup — atualização

Consulte `docs/BACKUP_SYSTEM.md` para procedimento atual e limites.

O guia anterior continha credenciais reais e foi substituído. Rotacione as credenciais expostas; não as coloque em documentação/git.

Pendências para ativação: migration incremental 020 aprovada, endpoint PostgreSQL remoto confirmado, BACKUP_TOKEN_KEY preservada fora da VPS, OAuth e ferramentas compatíveis, worker explicitamente habilitado.

Não há teste real de upload/restauração concluído. Pasta Google Drive criada não comprova backup. Não restaure sobre o banco em uso.
