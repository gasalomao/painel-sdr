# 🚀 PASSO A PASSO — Deploy no Easypanel (Hostinger)

## Pré-requisitos
- Conta no GitHub (gratuita)
- VPS Hostinger com Easypanel rodando
- n8n e Evolution API já funcionando no Easypanel

---

## PASSO 1: Subir o código para o GitHub

1. Crie uma conta no GitHub se não tiver: https://github.com
2. Clique em **"New Repository"** (botão verde)
3. Nome: `painel-sdr`
4. Deixe **Private** (privado)
5. Clique **"Create repository"**
6. No seu computador, abra o terminal na pasta do projeto e rode:

```bash
cd "C:\Users\Salomao\Desktop\meu sistema\painel-sdr"
git add .
git commit -m "primeiro deploy"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/painel-sdr.git
git push -u origin main
```

---

## PASSO 2: Criar o App no Easypanel

1. Acesse o painel do Easypanel da sua VPS
2. Clique em **"+ Create"** ou **"New Project"**
3. Selecione **"App"**
4. Nome do app: `painel-sdr`
5. Em **Source**, selecione **"GitHub"**
6. Conecte sua conta GitHub se ainda não conectou
7. Selecione o repositório `painel-sdr`
8. Branch: `main`

---

## PASSO 3: Configurar o Build

1. Tipo de Build: **Dockerfile**
2. Dockerfile Path: `./Dockerfile`
3. A porta padrão é **3000** (já está configurada no Dockerfile)

---

## PASSO 4: Configurar Variáveis de Ambiente

No Easypanel, vá em **"Environment"** do seu app e adicione:

| Variável | Valor |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://wcupppcomwfmpaagufvc.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjdXBwcGNvbXdmbXBhYWd1ZnZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NDIzNjksImV4cCI6MjA4NjQxODM2OX0.6VjvIJZYcclu_FU8dhA571U_ogN4Ujomi6IcX7y88M4` |
| `REDIS_URL` | `redis://default:Gabriel%403074@n8n_redis_local:6379` |
| `EVOLUTION_API_URL` | `https://n8n-evolution-api.sfrto8.easypanel.host` |
| `EVOLUTION_API_KEY` | `429683C4C977415CAAFCCE10F7D57E11` |
| `EVOLUTION_INSTANCE` | `sdr` |
| `N8N_WEBHOOK_LEAD` | `https://n8n-n8n.sfrto8.easypanel.host/webhook/LEAD` |
| `ADMIN_PASSWORD` | `Gabriel@3074` |


---

## PASSO 5: Deploy!

1. Clique em **"Deploy"**
2. Aguarde o build (pode levar 2-5 minutos)
3. Quando ficar verde, o painel está no ar!

---

## PASSO 6: Acessar o Painel

- O Easypanel vai gerar um domínio automático tipo: `painel-sdr-XXXX.easypanel.host`
- Você pode configurar um domínio personalizado em **"Domains"**

---

## PASSO 7: Configurar Realtime no Supabase

Para o chat em tempo real funcionar, você precisa habilitar o Realtime na tabela `n8n_chat_histories`:

1. Acesse o Supabase Dashboard
2. Vá em **Database > Tables**
3. Clique na tabela `n8n_chat_histories`
4. Aba **"Realtime"**
5. Ative o toggle para habilitar Realtime nesta tabela

---

## Onde encontrar as chaves

### Supabase URL e Anon Key:
1. Acesse https://supabase.com
2. Clique no seu projeto
3. Menu lateral: **Settings** (engrenagem)
4. Clique em **API**
5. Copie `Project URL` e `anon public` key

### Redis URL:
- Se o Redis está rodando como container no Easypanel, veja o hostname interno do container
- Geralmente é algo como `redis://nome-do-servico:6379`
- Veja no Easypanel o nome do serviço Redis

### Evolution API Key:
- Você já tem: é a `apikey` usada nos seus webhooks do n8n
- Está no payload do webhook como campo `apikey`

---

## Problemas Comuns

| Problema | Solução |
|----------|---------|
| Build falhou | Verifique os logs no Easypanel. Geralmente é variável de ambiente faltando |
| Dados não carregam | Verifique se `NEXT_PUBLIC_SUPABASE_URL` e `ANON_KEY` estão corretos |
| Chat não atualiza em tempo real | Habilite Realtime na tabela `n8n_chat_histories` no Supabase |
| Mensagens não enviam | Verifique `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` |
| Redis não conecta | Verifique o hostname interno do container Redis no Easypanel |
