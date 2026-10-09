# Deploy no EasyPanel

Este guia explica como fazer deploy do Painel SDR no EasyPanel.

## Pré-requisitos

1. Conta no [EasyPanel](https://easypanel.io/)
2. Projeto Supabase configurado
3. API keys necessárias (DeepSeek, Anthropic, OpenAI)

## Passo a Passo

### 1. Push do código para o GitHub

```bash
git add .
git commit -m "Preparação para deploy no EasyPanel"
git push origin main
```

### 2. Configurar no EasyPanel

1. Acesse o EasyPanel
2. Clique em "New Project"
3. Selecione "GitHub Repository"
4. Escolha o repositório `painel-sdr`
5. Configure o build:
   - **Build Context**: `/`
   - **Dockerfile**: `Dockerfile`
   - **Port**: `3000`

### 3. Variáveis de Ambiente

Configure as seguintes variáveis no EasyPanel:

#### Variáveis Públicas (Build time)
```
NEXT_PUBLIC_SUPABASE_URL=sua-url-do-supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
NEXT_PUBLIC_APP_URL=https://seu-dominio.easypanel.host
```

#### Variáveis Privadas (Runtime)
```
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
DEEPSEEK_API_KEY=sua-deepseek-key
ANTHROPIC_API_KEY=sua-anthropic-key
OPENAI_API_KEY=sua-openai-key
NODE_ENV=production
```

### 4. Configurações Adicionais

#### Health Check
- **Path**: `/api/health`
- **Interval**: `30s`
- **Timeout**: `10s`
- **Retries**: `3`

#### Resources (Recomendado)
- **Memory**: `2GB` (mínimo)
- **CPU**: `1 vCPU`

### 5. Deploy

1. Clique em "Deploy"
2. Aguarde o build completar (pode levar 5-10 minutos na primeira vez)
3. Acesse a URL fornecida pelo EasyPanel

## Domínio Personalizado

Para usar um domínio próprio:

1. Vá em "Domains" no EasyPanel
2. Adicione seu domínio
3. Configure os DNS conforme instruções
4. Atualize `NEXT_PUBLIC_APP_URL` com o novo domínio

## Monitoramento

O projeto inclui endpoints de monitoramento:

- **Health**: `GET /api/health` - Status geral do sistema
- **Logs**: Disponíveis no dashboard do EasyPanel

## Troubleshooting

### Build falha
- Verifique se todas as variáveis de ambiente estão configuradas
- Confirme que as API keys são válidas

### Aplicação não inicia
- Verifique os logs no EasyPanel
- Confirme que a porta 3000 está exposta
- Verifique o health check

### Problemas de conexão com Supabase
- Verifique as URLs e keys
- Confirme que o Supabase está acessível
- Verifique as RLS policies

## Atualizações

Para atualizar a aplicação:

1. Faça push das mudanças para o GitHub
2. O EasyPanel detectará automaticamente
3. Clique em "Redeploy" ou configure auto-deploy

## Suporte

Para problemas específicos do EasyPanel, consulte:
- [Documentação do EasyPanel](https://easypanel.io/docs)
- [Discord do EasyPanel](https://discord.gg/easypanel)
