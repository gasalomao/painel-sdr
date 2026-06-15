# Disaster Recovery — Restaurar Banco do Zero

> Esse documento é o **plano de emergência** caso o Supabase morra, seja perdido ou você queira clonar pra outro ambiente. Mantenha sincronizado com [`SETUP_COMPLETO.sql`](SETUP_COMPLETO.sql).

## Quando usar

- Supabase do Easypanel quebrou e precisa subir do zero
- Migrando pra outro provedor (Supabase cloud, RDS, etc)
- Criando ambiente de staging/dev clonando estrutura
- Erro `relation "X" does not exist` no app

## Passo a passo (5 minutos)

### 1. Cria um Supabase novo

**Self-hosted (Easypanel):** New Service → Supabase template → wait healthy
**Cloud:** [supabase.com/dashboard](https://supabase.com/dashboard) → New project

### 2. Pega a connection string

- Self-hosted: a do `.env` do Easypanel (`POSTGRES_PASSWORD`, host externo)
- Cloud: Project Settings → Database → Connection string → URI

### 3. Abre o SQL Editor

- Self-hosted: Studio do Supabase via Easypanel ou `http://SEUHOST:8000`
- Cloud: menu lateral → SQL Editor

### 4. Cola o arquivo inteiro

Abre o [`SETUP_COMPLETO.sql`](SETUP_COMPLETO.sql) no editor de texto, `Ctrl+A` → `Ctrl+C` → cola no SQL Editor → **Run**.

Deve responder "Success. No rows returned" em ~3 segundos. Se der erro, ver seção [Troubleshooting](#troubleshooting).

### 5. Verifica que voltou tudo

Roda no SQL Editor:

```sql
SELECT
  (SELECT COUNT(*) FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace) AS tabelas,
  (SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public') AS indices,
  (SELECT COUNT(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace) AS fks;
```

Esperado:
| tabelas | indices | fks |
|---------|---------|-----|
| 32      | ~85     | 44  |

### 6. Cria o primeiro cliente admin

```sql
INSERT INTO public.clients (id, name, email, is_admin, is_active, password_hash)
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Admin',
  'admin@suaempresa.com',
  true,
  true,
  -- Hash de "TROCAR123": gere o seu via hashPassword() do app, ou
  -- deixe NULL e use a tela /admin/clientes pra setar depois
  NULL
);
```

### 7. Atualiza `.env` da app

```env
NEXT_PUBLIC_SUPABASE_URL=http://SEUHOST:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

### 8. Restart o app no Easypanel

Done. Login com `admin@suaempresa.com` → reconfigurar API keys do Gemini em `/configuracoes`.

---

## O que NÃO está coberto pelo SETUP

Esses itens precisam ser refeitos manualmente em recovery:

| Item | Onde recriar |
|---|---|
| **Storage buckets** (`whatsapp_media`) | App cria sozinho via `/api/setup-db` quando subir |
| **Realtime publications** | Supabase Studio → Database → Replication → habilitar tabelas de chat |
| **RLS policies** | App usa `service_role`, não depende. Se quiser RLS estrito, escrever policies à parte |
| **Dados** (clientes, leads, chats, mensagens) | **Não é recuperável** sem backup do `pg_dump` com `--data-only`. SETUP só recria estrutura |
| **API keys** (Gemini, Google Calendar) | Reconfigurar via `/configuracoes` |
| **Evolution API instances** | Reconectar QR Code pra cada instância em `/whatsapp` |

---

## Backup proativo (recomendado fazer 1x/semana)

Pra ter os **dados** também (não só estrutura), além desse arquivo:

```bash
pg_dump "postgresql://postgres:SENHA@HOST:PORTA/postgres" \
  --data-only --no-owner --schema=public \
  -f backup_$(date +%Y%m%d).sql
```

Guardar fora do Easypanel (Google Drive, S3, GitHub privado).

**Restaurar dados depois do schema:**
```bash
psql "postgresql://..." -f backup_AAAAMMDD.sql
```

---

## Troubleshooting

| Erro no SQL Editor | Causa | Solução |
|---|---|---|
| `extension "vector" is not available` | Postgres sem pgvector | Self-hosted: habilitar extensão no docker; Cloud: já vem default |
| `permission denied for schema public` | Usuário sem perm | Roda com superuser/postgres, não com anon |
| `relation "X" already exists` | Banco não está vazio | O `IF NOT EXISTS` cuida disso — confere se o erro é em outra coisa |
| Travou em alguma `CREATE INDEX` | Tabela com muitos dados sem o índice ainda | Espera — HNSW em tabela grande demora |

---

## Manter atualizado

Quando alterar schema (`ALTER TABLE`, `CREATE INDEX`, etc):

1. Roda a alteração em produção
2. Pede pro Claude regenerar o `SETUP_COMPLETO.sql` via introspecção
3. Commit + push

Senão esse arquivo fica desatualizado e o disaster recovery não funciona.

**Última sincronização:** 2026-05-27 (commit `5ec7690`)
