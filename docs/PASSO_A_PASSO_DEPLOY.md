# PASSO A PASSO — Deploy no Easypanel

## Pré-requisitos
- Conta no GitHub (gratuita)
- VPS com Easypanel rodando
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

No Easypanel, vá em **"Environment"** do seu app e adicione (substitua pelos seus valores reais):

| Variável | Valor |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://seu-supabase.easypanel.host` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sua-anon-key` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sua-service-role-key` |
| `EVOLUTION_API_URL` | `https://seu-evolution-api.easypanel.host` |
| `EVOLUTION_API_KEY` | `sua-evolution-api-key` |
| `EVOLUTION_INSTANCE` | `sdr` |
| `EVOLUTION_GO_URL` | `https://seu-evolution-go.easypanel.host` |
| `EVOLUTION_GO_KEY` | `sua-evolution-go-key` |
| `REDIS_HOST` | `sistema_redis` |
| `REDIS_PORT` | `6379` |
| `REDIS_PASSWORD` | `sua-senha-redis` |
| `ADMIN_PASSWORD` | `sua-senha-admin` |
| `NEXT_PUBLIC_APP_URL` | `https://seu-app.easypanel.host` |

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

Para o chat em tempo real funcionar, você precisa habilitar o Realtime nas tabelas:

1. Acesse o Supabase Dashboard
2. Vá em **Database > Replication**
3. Verifique se a publicação `supabase_realtime` lista as tabelas `chats_dashboard`, `messages`, `sessions`

---

## Onde encontrar as chaves

### Supabase URL e Anon Key:
1. Acesse seu Supabase Studio
2. Vá em **Settings → API**
3. Copie `Project URL` e `anon public` key

### Redis:
- Se o Redis está rodando como container no Easypanel, veja o hostname interno do container
- Geralmente é algo como `redis://nome-do-servico:6379`

### Evolution API Key:
- É a `apikey` usada nos seus webhooks
- Está no payload do webhook como campo `apikey`

---

## Problemas Comuns

| Problema | Solução |
|----------|---------|
| Build falhou | Verifique os logs no Easypanel. Geralmente é variável de ambiente faltando |
| Dados não carregam | Verifique se `NEXT_PUBLIC_SUPABASE_URL` e `ANON_KEY` estão corretos |
| Chat não atualiza em tempo real | Habilite Realtime nas tabelas no Supabase |
| Mensagens não enviam | Verifique `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` |
| Redis não conecta | Verifique o hostname interno do container Redis no Easypanel |
