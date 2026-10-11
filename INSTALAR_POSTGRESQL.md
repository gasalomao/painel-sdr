# Ferramentas PostgreSQL para backup

A documentação vigente é [docs/BACKUP_SYSTEM.md](docs/BACKUP_SYSTEM.md). Este documento substitui instruções antigas de instalação e restauração.

O erro `'PGPASSWORD' não é reconhecido como um comando interno` indica sintaxe de atribuição incompatível com o shell Windows; não comprova ausência de `pg_dump`. O código atual passa credenciais pelo ambiente de subprocesso sem shell.

## Verificação local

```powershell
pg_dump --version
pg_dumpall --version
pg_restore --version
psql --version
```

Se as ferramentas não existirem, obtenha o cliente pelo distribuidor oficial: https://www.postgresql.org/download/windows/. A versão major de `pg_dump` precisa ser igual ou mais nova que a do servidor; não fixe uma versão sem conhecer o destino.

Configure `POSTGRES_BIN_DIR` no ambiente do servidor quando necessário. No Windows, o código também procura instalações em `Program Files/PostgreSQL`. Não altere o PATH global nem reinicie processos sem necessidade/aprovação.

Ter o cliente instalado não comprova conectividade, permissões, upload ou recuperação. Configure o endpoint PostgreSQL remoto, OAuth, chave de tokens e migrations com aprovação específica, depois execute diagnóstico controlado. Nunca teste restauração sobre o banco em uso.
