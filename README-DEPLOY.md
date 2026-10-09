# Deploy no Easy Panel

Este guia contém as instruções completas para fazer deploy do Painel SDR no Easy Panel.

## Pré-requisitos

- Conta no Easy Panel
- Conta no Supabase (banco de dados)
- Conta no Evolution API (WhatsApp)
- Redis (opcional, mas recomendado)

## 1. Preparar o Banco de Dados (Supabase)

### 1.1. Criar Projeto no Supabase

1. Acesse https://supabase.com
2. Crie um novo projeto
3. Anote as credenciais:
   - `Project URL` (NEXT_PUBLIC_SUPABASE_URL)
   - `anon/public key` (NEXT_PUBLIC_SUPABASE_ANON_KEY)
   - `service_role key` (SUPABASE_SERVICE_ROLE_KEY)

### 1.2. Executar as Migrations

Execute os scripts SQL na ordem, no SQL Editor do Supabase:

```sql
-- 1. Copie e execute o conteúdo de: migrations/001_initial_schema.sql
-- 2. Continue com os demais arquivos em ordem numérica até 017
```

**IMPORTANTE**: Execute todos os arquivos de migration de `001` até `017` para garantir que todas as tabelas e funções estejam criadas.

### 1.3. Verificar RLS (Row Level Security)

Certifique-se de que as políticas RLS estão ativas em todas as tabelas multi-tenant:
- `companies`
- `users`
- `contacts`
- `conversations`
- `messages`
- `website_projects`
- `website_runs`
- `website_activity_logs`

## 2. Configurar o Easy Panel

### 2.1. Criar Novo App

1. Acesse seu Easy Panel
2. Clique em **"New App"**
3. Selecione **"GitHub"**
4. Conecte ao repositório: `https://github.com/gasalomao/painel-sdr.git`
5. Branch: `main`

### 2.2. Configurações do Build

**Build Settings:**
```
Build Command: npm ci && npm run build
Start Command: npm run start
Port: 3000
```

**Node Version:**
```
Node.js 22.x ou superior
```

### 2.3. Variáveis de Ambiente

Configure no Easy Panel em **"Environment Variables"**:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://sua-evolution-api.com
EVOLUTION_API_KEY=sua-api-key
EVOLUTION_INSTANCE=sdr

# Evolution GO (opcional)
EVOLUTION_GO_URL=https://sua-evolution-go.com
EVOLUTION_GO_KEY=sua-go-key

# Redis (se disponível)
REDIS_HOST=seu-redis-host
REDIS_PORT=6379
REDIS_PASSWORD=sua-senha-redis
REDIS_USERNAME=default

# App
ADMIN_PASSWORD=sua-senha-admin-segura
NEXT_PUBLIC_APP_URL=https://seu-dominio.com
INTERNAL_APP_URL=https://seu-dominio.com
PORT=3000
HOSTNAME=0.0.0.0
NODE_ENV=production

# AI Providers (opcional - Site Studio)
OPENROUTER_API_KEY=sua-key-openrouter
GOOGLE_AI_API_KEY=sua-key-google
DEEPSEEK_API_KEY=sua-key-deepseek
```

### 2.4. Configurar Domínio

1. Em **"Domains"**, adicione seu domínio
2. Configure o DNS apontando para o IP do Easy Panel
3. Ative SSL automático

### 2.5. Configurar Workers (BullMQ)

Se você tiver Redis configurado, adicione um segundo serviço para os workers:

**Worker Service:**
```
Build Command: npm ci
Start Command: npm run workers
Port: (não precisa)
```

Use as mesmas variáveis de ambiente do app principal.

## 3. Deploy

### 3.1. Fazer o Push

```bash
# No seu computador local:
cd painel-sdr-main

# Adicionar todas as mudanças
git add .

# Commitar
git commit -m "feat: preparar para deploy no Easy Panel"

# Push para o GitHub
git push origin main
```

### 3.2. Deploy Automático

O Easy Panel detectará o push e iniciará o build automaticamente.

Acompanhe os logs em **"Logs"** no painel.

## 4. Verificação Pós-Deploy

### 4.1. Testar a Aplicação

1. Acesse: `https://seu-dominio.com`
2. Faça login com as credenciais padrão
3. Teste os principais fluxos:
   - Criar empresa
   - Adicionar usuários
   - Configurar WhatsApp
   - Criar contatos
   - Enviar mensagens

### 4.2. Verificar Logs

```bash
# No Easy Panel, verifique:
- Application Logs
- Build Logs
- Error Logs
```

### 4.3. Monitorar Performance

- CPU Usage
- Memory Usage
- Request Rate
- Response Time

## 5. Troubleshooting

### Build Falha

**Erro de memória durante build:**
```bash
# No Easy Panel, aumente o limite de memória do Node:
NODE_OPTIONS=--max-old-space-size=4096
```

**Erro de dependências:**
```bash
# Limpe o cache e reinstale:
npm ci --force
```

### Aplicação Não Inicia

**Porta em uso:**
- Verifique se a variável `PORT=3000` está configurada
- Certifique-se de que `HOSTNAME=0.0.0.0` para escutar em todas as interfaces

**Erro de banco de dados:**
- Verifique as credenciais do Supabase
- Confirme que todas as migrations foram executadas
- Teste a conexão no SQL Editor do Supabase

### Redis Indisponível

A aplicação funciona sem Redis, mas com funcionalidade reduzida:
- Sem filas de mensagens
- Sem cache de sessão
- Processamento síncrono

Para melhor performance, recomenda-se ter Redis configurado.

### WhatsApp Não Conecta

1. Verifique as credenciais da Evolution API
2. Teste a API diretamente:
```bash
curl -X GET \
  -H "apikey: sua-api-key" \
  https://sua-evolution-api.com/instance/connectionState/sdr
```

3. Verifique se a instância está criada e ativa

## 6. Manutenção

### Atualizar o App

```bash
# Local
git pull origin main
git add .
git commit -m "feat: suas mudanças"
git push origin main

# Easy Panel fará o deploy automaticamente
```

### Backup do Banco

No Supabase:
1. Vá em **"Database"** > **"Backups"**
2. Configure backups automáticos
3. Faça backups manuais antes de mudanças grandes

### Logs e Debugging

```bash
# Ver logs em tempo real no Easy Panel
# Ou via CLI (se disponível):
easypanel logs -f seu-app
```

## 7. Segurança

### Checklist de Segurança

- [ ] Todas as senhas e API keys são fortes e únicas
- [ ] HTTPS está ativo (SSL/TLS)
- [ ] RLS está habilitado no Supabase
- [ ] Variáveis de ambiente estão protegidas
- [ ] CORS está configurado corretamente
- [ ] Rate limiting está ativo
- [ ] Backups automáticos configurados
- [ ] Logs de acesso habilitados
- [ ] 2FA habilitado no Supabase e Easy Panel

### Atualizar Senhas

```bash
# Gere senhas fortes:
openssl rand -base64 32

# Atualize no Easy Panel e no Supabase
```

## 8. Suporte

### Links Úteis

- Documentação Easy Panel: https://easypanel.io/docs
- Documentação Supabase: https://supabase.com/docs
- Evolution API: https://doc.evolution-api.com
- Next.js: https://nextjs.org/docs

### Problemas Comuns

Consulte o arquivo `TROUBLESHOOTING.md` para soluções de problemas específicos.

---

**Última atualização**: 2025-01-08
**Versão**: 1.0.0
