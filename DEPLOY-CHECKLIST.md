# ✅ CHECKLIST DE DEPLOY - EASY PANEL

Use este checklist para garantir que o deploy será feito corretamente.

## 📋 Pré-Deploy

### 1. Banco de Dados (Supabase)

- [ ] Criar conta no Supabase (https://supabase.com)
- [ ] Criar novo projeto no Supabase
- [ ] Anotar as credenciais:
  - [ ] Project URL
  - [ ] anon/public key
  - [ ] service_role key
- [ ] Executar migrations no SQL Editor:
  - [ ] 001_initial_schema.sql
  - [ ] 002_*.sql
  - [ ] ... (todos em ordem)
  - [ ] 017_website_studio_completion_guard.sql
  - [ ] 017_website_activity_logs.sql
- [ ] Verificar se RLS está ativo em todas as tabelas
- [ ] Configurar backups automáticos

### 2. Evolution API (WhatsApp)

- [ ] Ter Evolution API rodando (Node.js ou Go)
- [ ] Anotar credenciais:
  - [ ] API URL
  - [ ] API Key
  - [ ] Nome da instância
- [ ] Testar conexão da API:
```bash
curl -X GET \
  -H "apikey: SUA_API_KEY" \
  https://sua-evolution-api.com/instance/connectionState/sdr
```

### 3. Redis (Opcional mas Recomendado)

- [ ] Provisionar Redis (UpStash, Railway, Redis Cloud)
- [ ] Anotar credenciais:
  - [ ] Host
  - [ ] Port
  - [ ] Password
  - [ ] Username

### 4. Repositório GitHub

- [ ] ✅ Código enviado para o GitHub
- [ ] ✅ Branch `main` atualizada
- [ ] Verificar se `.env` está no `.gitignore`
- [ ] Verificar se não há secrets commitados

---

## 🚀 Deploy no Easy Panel

### 1. Criar App

- [ ] Acessar Easy Panel
- [ ] Clicar em "New App"
- [ ] Selecionar "GitHub"
- [ ] Conectar ao repositório: `gasalomao/painel-sdr`
- [ ] Branch: `main`

### 2. Configurar Build

**Build Settings:**
```
Build Command: npm ci && npm run build
Start Command: npm run start
Port: 3000
Node Version: 22.x
```

- [ ] Build Command configurado
- [ ] Start Command configurado
- [ ] Port 3000 configurado
- [ ] Node.js 22.x selecionado

### 3. Variáveis de Ambiente

Configurar em "Environment Variables":

#### Supabase (obrigatório)
- [ ] `NEXT_PUBLIC_SUPABASE_URL` = https://seu-projeto.supabase.co
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` = sua-anon-key
- [ ] `SUPABASE_SERVICE_ROLE_KEY` = sua-service-role-key

#### Evolution API (obrigatório)
- [ ] `EVOLUTION_API_URL` = https://sua-evolution-api.com
- [ ] `EVOLUTION_API_KEY` = sua-api-key
- [ ] `EVOLUTION_INSTANCE` = sdr

#### Redis (recomendado)
- [ ] `REDIS_HOST` = seu-redis-host
- [ ] `REDIS_PORT` = 6379
- [ ] `REDIS_PASSWORD` = sua-senha-redis
- [ ] `REDIS_USERNAME` = default

#### App (obrigatório)
- [ ] `ADMIN_PASSWORD` = senha-segura-aqui
- [ ] `NEXT_PUBLIC_APP_URL` = https://seu-dominio.com
- [ ] `INTERNAL_APP_URL` = https://seu-dominio.com
- [ ] `PORT` = 3000
- [ ] `HOSTNAME` = 0.0.0.0
- [ ] `NODE_ENV` = production

#### AI Providers (opcional - Site Studio)
- [ ] `OPENROUTER_API_KEY` = sua-key (opcional)
- [ ] `GOOGLE_AI_API_KEY` = sua-key (opcional)
- [ ] `DEEPSEEK_API_KEY` = sua-key (opcional)

### 4. Domínio

- [ ] Adicionar domínio personalizado
- [ ] Configurar DNS (A record para IP do Easy Panel)
- [ ] Ativar SSL automático
- [ ] Aguardar propagação DNS (pode levar até 24h)

### 5. Workers (Opcional - se tiver Redis)

Adicionar segundo serviço:

```
Service Name: painel-sdr-workers
Build Command: npm ci
Start Command: npm run workers
Environment: (mesmas variáveis do app principal)
```

- [ ] Worker service criado
- [ ] Variáveis de ambiente copiadas
- [ ] Worker iniciado com sucesso

### 6. Iniciar Deploy

- [ ] Clicar em "Deploy"
- [ ] Acompanhar logs de build
- [ ] Verificar se build completa sem erros
- [ ] Verificar se app inicia corretamente

---

## ✅ Pós-Deploy

### 1. Verificação Básica

- [ ] App acessível via domínio
- [ ] Login funciona
- [ ] Dashboard carrega
- [ ] Sem erros no console do browser

### 2. Testar Funcionalidades

- [ ] **Autenticação**
  - [ ] Login funciona
  - [ ] Logout funciona
  - [ ] Sessão persiste
  
- [ ] **Empresas**
  - [ ] Criar empresa funciona
  - [ ] Listar empresas funciona
  - [ ] Editar empresa funciona
  
- [ ] **Usuários**
  - [ ] Criar usuário funciona
  - [ ] Listar usuários funciona
  - [ ] Permissões funcionam
  
- [ ] **WhatsApp**
  - [ ] Configurar instância funciona
  - [ ] QR Code aparece
  - [ ] Conectar funciona
  - [ ] Enviar mensagem funciona
  - [ ] Receber mensagem funciona
  
- [ ] **Contatos**
  - [ ] Criar contato funciona
  - [ ] Listar contatos funciona
  - [ ] Editar contato funciona
  
- [ ] **Conversas**
  - [ ] Listar conversas funciona
  - [ ] Abrir conversa funciona
  - [ ] Histórico carrega
  
- [ ] **Site Studio** (se configurado)
  - [ ] Criar projeto funciona
  - [ ] Gerar site funciona
  - [ ] Preview funciona

### 3. Verificar Logs

- [ ] Verificar logs da aplicação
- [ ] Verificar logs do worker (se ativo)
- [ ] Sem erros críticos nos logs

### 4. Performance

- [ ] App responde rápido (< 2s)
- [ ] Sem memory leaks
- [ ] CPU usage normal
- [ ] Sem erros de timeout

### 5. Monitoramento

- [ ] Configurar alertas de erro no Easy Panel
- [ ] Configurar alertas de downtime
- [ ] Configurar monitoramento de recursos

---

## 🔐 Segurança

### Checklist de Segurança

- [ ] Todas as senhas são fortes e únicas
- [ ] HTTPS está ativo
- [ ] RLS está habilitado no Supabase
- [ ] Variáveis de ambiente protegidas
- [ ] `.env` não está no repositório
- [ ] Rate limiting está ativo
- [ ] CORS configurado corretamente
- [ ] Backups automáticos configurados
- [ ] 2FA habilitado no Supabase
- [ ] 2FA habilitado no Easy Panel

---

## 🆘 Problemas Comuns

### Build Falha

**Erro de memória:**
```
Adicionar variável: NODE_OPTIONS=--max-old-space-size=4096
```

**Erro de dependências:**
```
Verificar package.json
Tentar: npm ci --force
```

### App Não Inicia

**Porta em uso:**
- Verificar PORT=3000
- Verificar HOSTNAME=0.0.0.0

**Erro de banco:**
- Verificar credenciais Supabase
- Verificar se migrations foram executadas
- Testar conexão no Supabase

### WhatsApp Não Conecta

- Verificar credenciais Evolution API
- Testar API diretamente com curl
- Verificar se instância existe e está ativa

---

## 📞 Suporte

- Documentação: Ver `README-DEPLOY.md`
- Issues: https://github.com/gasalomao/painel-sdr/issues
- Logs: Verificar no Easy Panel > Logs

---

**✅ Deploy Concluído com Sucesso!**

Data: ___/___/___
Responsável: _____________
Domínio: _____________
