# Deploy no Easypanel — Guia completo (2026)

Guia prático pra subir o **Painel SDR** numa VPS com Easypanel, puxando direto do
GitHub. Nenhuma funcionalidade fica de fora: chat, IA, disparo, follow-up,
scraper Google Maps (Puppeteer + Chromium), Evolution API, organizador IA, etc.

> Tempo estimado do **primeiro** deploy: **8–12 min** (Chromium baixa no
> primeiro build). Deploys subsequentes: **2–3 min** (cache do BuildKit).

---

## 0. Pré-requisitos

- VPS com Easypanel rodando (IP: `157.173.110.24`).
- Repositório no GitHub com o projeto: `https://github.com/gasalomao/painel-sdr`.
- Supabase self-hosted no Easypanel (URL + anon key + **service_role key**).
- Evolution API V2 acessível no Easypanel (`https://sistema-evolution-api.ridnli.easypanel.host`).
- Redis acessível no Easypanel (`sistema_redis:6379`).
- API Key do Gemini (`https://aistudio.google.com/apikey`).

---

## 1. Subir o schema do banco (uma vez só)

No **SQL Editor do Supabase** (acesse via Studio), cole e rode **APENAS** o arquivo:

```
SETUP_COMPLETO.sql
```

(está na raiz do repositório). Ele é idempotente — pode rodar várias vezes sem
quebrar nada. Cria todas as tabelas, colunas, índices, permissões, bucket de
storage `whatsapp_media`, publicação realtime e os seeds iniciais.

Depois de rodar, abra **Configurações → Setup do Banco → Verificar agora**
no painel: tem que aparecer o badge verde **"Banco pronto"**.

---

## 2. Criar o serviço no Easypanel

1. **+ Service → App**.
2. **Source**:
   - Type: **GitHub**
   - Repository: `gasalomao/painel-sdr`
   - Branch: `main`
   - Build Path: *(deixa em branco)*
3. **Build**:
   - Builder: **Dockerfile**
   - Dockerfile Path: `Dockerfile`
4. **Deploy**:
   - Port: `3000`

Cola o nome do serviço (ex.: `sdr`) e segue.

---

## 3. Variáveis de ambiente (Environment)

Cola o bloco abaixo na aba **Environment** do serviço, **trocando os valores
em MAIÚSCULO** pelos seus reais.

```env
# ============= SUPABASE (self-hosted) =============
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnii.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q

# ============= EVOLUTION (WhatsApp) =============
EVOLUTION_API_URL=https://sistema-evolution-api.ridnli.easypanel.host
EVOLUTION_API_KEY=Gabriel@3074
EVOLUTION_INSTANCE=sdr

# ============= REDIS =============
REDIS_HOST=sistema_redis
REDIS_PORT=6379
REDIS_PASSWORD=Gabriel@3074
REDIS_USERNAME=default

# ============= APP =============
ADMIN_PASSWORD=Gabriel@3074
NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnii.easypanel.host
INTERNAL_APP_URL=http://localhost:3000
PORT=3000
HOSTNAME=0.0.0.0
NODE_ENV=production
```

> **IMPORTANTE — variáveis `NEXT_PUBLIC_*` são fixadas no BUILD.**
> Toda variável que começa com `NEXT_PUBLIC_` é injetada no JavaScript
> do cliente durante `next build`. Se você mudar uma delas depois (ex.: o
> domínio do app), precisa fazer **Rebuild** (não basta Restart).

---

## 4. Build args (obrigatório)

Em **Build → Build Args**, cole as variáveis `NEXT_PUBLIC_*` e
`SUPABASE_SERVICE_ROLE_KEY`:

```
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnii.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnii.easypanel.host
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q
```

---

## 5. Domínio + SSL

Em **Domains** do serviço:
- Adicione o domínio: `https://sistema-sdr.ridnli.easypanel.host`
- Marque **Force SSL** (HTTPS obrigatório).

---

## 6. Resources / Limits

Recomendação mínima:
- **Memory**: 2 GB (build), 1 GB (runtime).
- **CPU**: 1 vCPU suficiente. 2 vCPU acelera o build.

Se o build matar por OOM, adicione `NODE_OPTIONS=--max-old-space-size=2048` no Environment **e** Build Args.

---

## 7. Deploy

Clica em **Deploy**. O Easypanel vai:
1. Clonar o repo da branch `main`.
2. Rodar o `Dockerfile` em multi-stage (node:20-alpine).
3. Subir o container expondo a porta 3000.
4. Rotear o domínio configurado pro container.

Sucesso quando aparece nos logs:
```
▲ Next.js 16.x
- Local:        http://0.0.0.0:3000
✓ Ready in ~1s
```

---

## 8. Primeiro acesso (configuração inicial pela UI)

Abra `https://sistema-sdr.ridnli.easypanel.host`.

1. **Login**: senha = `Gabriel@3074`.
2. **Configurações → Google Gemini API Key**: cola sua chave do AI Studio.
   Salva. Aparece "Configurada" verde.
3. **Configurações → Evolution API**: confirma se a URL/apikey/instância
   estão certas. Clica em **Testar conexão** — deve aparecer verde.
4. **Configurações → Setup do Banco → Verificar agora** — confirma "Banco pronto".
5. **Agente IA → Sincronizar Webhook**: o painel configura o webhook apontando pra
   `https://sistema-sdr.ridnli.easypanel.host/api/webhooks/evolution`.
6. Manda uma mensagem de teste no WhatsApp e confere se chega no **Chat**.

---

## 9. Auto-deploy a cada `git push`

Em **Settings** do serviço:
- Ativa **Auto Deploy** (webhook do GitHub → Easypanel).
- Em todo `git push origin main`, o Easypanel rebuilda sozinho.

---

## 10. Trocar Evolution de VPS (sem rebuild!)

1. Subiu uma Evolution nova?
2. Vai em **Configurações → Evolution API** no painel.
3. Cola **URL nova** + **API Key nova** + **nome da instância**.
4. Clica **Salvar e conectar** — o sistema testa, persiste no DB e passa a usar imediatamente.

Sem rebuild. Sem mexer em ENV. Sem reiniciar container.

---

## 11. Troubleshooting

### Build falha por OOM
Logs com `JavaScript heap out of memory`:
- Aumentar memória do serviço pra 2 GB+.
- Adicionar `NODE_OPTIONS=--max-old-space-size=2048` no Environment **e** Build Args.

### Container sobe mas `/` dá erro 500
Quase sempre é uma das envs faltando:
- `SUPABASE_SERVICE_ROLE_KEY` está setada?
- `NEXT_PUBLIC_SUPABASE_URL` é HTTPS válido?

### Evolution API "offline"
- O container da Evolution está crashando. Reinicie o serviço.
- Clique **Testar conexão** de novo.

### Webhook do WhatsApp não chega
- O `NEXT_PUBLIC_APP_URL` está correto?
- Rode **Sincronizar Webhook** na tela do Agente IA.

### Realtime (chat ao vivo) não atualiza
- Confere que rodou a `PARTE 14 — REALTIME` do `SETUP_COMPLETO.sql`.
- Em Supabase: Database → Replication → `supabase_realtime` deve listar as tabelas.

---

## 12. Checklist final de deploy

- [ ] `SETUP_COMPLETO.sql` rodado no Supabase.
- [ ] Builder = `Dockerfile` no Easypanel.
- [ ] Todas as envs coladas no **Environment**.
- [ ] Build Args preenchidos.
- [ ] Domínio + SSL ativos.
- [ ] Build verde (sem erros nos Deployments).
- [ ] Login funciona com `ADMIN_PASSWORD`.
- [ ] **Configurações → Setup do Banco → Verificar agora** = ✅ verde.
- [ ] **Configurações → Evolution API → Testar conexão** = ✅ verde.
- [ ] **Configurações → Google Gemini → Testar chave** = ✅ verde.
- [ ] Mensagem de teste WhatsApp → chega no painel /chat.
- [ ] Auto Deploy ativado.
