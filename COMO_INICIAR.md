# 🚀 COMO INICIAR O SISTEMA

**Última atualização:** 2026-10-09  
**Tempo para iniciar:** ~2 minutos

---

## ⚡ INÍCIO RÁPIDO (3 comandos)

```powershell
# Terminal 1: Worker BullMQ
cd C:\Users\Salomão\Desktop\painel-sdr-main
npm run sites:worker

# Terminal 2: Dev Server
cd C:\Users\Salomão\Desktop\painel-sdr-main
npm run dev

# Terminal 3 (opcional): Testes
cd C:\Users\Salomão\Desktop\painel-sdr-main
npm test -- --watch
```

Depois abrir: **http://localhost:3000/sites**

---

## 📋 PRÉ-REQUISITOS

### 1. Variáveis de Ambiente
Verificar se `.env.local` existe e contém:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# OpenRouter (IA)
OPENROUTER_API_KEY=...

# Outros providers (opcional)
GOOGLE_GENERATIVE_AI_API_KEY=...
NVIDIA_API_KEY=...
```

### 2. Dependências Instaladas
```powershell
npm install
```

### 3. Banco de Dados
Migrations já devem estar aplicadas. Verificar:
```powershell
npm run db:verify
```

---

## 🔧 INICIAR COMPONENTES

### 1. Worker (Obrigatório)

O worker processa as runs de IA em background.

```powershell
# Terminal dedicado
npm run sites:worker
```

**Esperar ver:**
```
[Worker] Started worker sites-worker-12345
[Worker] Waiting for jobs...
```

**Logs importantes:**
- `[Worker] Claimed run: <runId>` - Pegou uma run
- `[Checkpoint] Saved after write` - Salvou checkpoint ✅
- `[worker] Failed to insert activity` - Erro ao emitir evento ❌

### 2. Dev Server (Obrigatório)

Next.js dev server para a UI.

```powershell
# Terminal dedicado
npm run dev
```

**Esperar ver:**
```
▲ Next.js 16.0.0
- Local:        http://localhost:3000
- Ready in 2.1s
```

**Acessar:**
- UI: http://localhost:3000/sites
- API: http://localhost:3000/api/sites

### 3. Testes (Opcional)

```powershell
# Terminal dedicado (opcional)
npm test -- --watch
```

Ou rodar uma vez:
```powershell
npm test
npm run sites:test-preview
```

---

## 🧪 TESTAR ARQUIVOS EM TEMPO REAL

### Setup Rápido
1. ✅ Worker rodando
2. ✅ Dev server rodando
3. ✅ Abrir http://localhost:3000/sites
4. ✅ DevTools Console aberto (F12)

### Teste 1: Criar Site
1. Clicar "Novo Projeto"
2. Nome: "Teste Realtime"
3. Criar projeto
4. **Ver Console:** Deve aparecer logs de conexão

### Teste 2: Gerar Código
1. No chat, enviar: "Crie um site simples com header azul"
2. **Ver Console:**
   ```
   [SSE] File file_create detected: src/Header.tsx
   [Checkpoint] Updated with 2 files
   [SSE] File file_write detected: src/App.tsx
   [Checkpoint] Updated with 3 files
   ```
3. **Ver UI:**
   - Arquivos aparecem em <500ms
   - Contador incrementa: "3 arquivos"
   - Tab "Arquivos ao Vivo" atualiza

### Sucesso = ✅
- Console mostra logs `[SSE]` e `[Checkpoint]`
- Arquivos aparecem quase instantaneamente
- Preview atualiza automaticamente

---

## 🐛 PROBLEMAS COMUNS

### Worker não inicia

**Erro:** `Cannot find module 'bullmq'`
```powershell
npm install
```

**Erro:** `SUPABASE_SERVICE_ROLE_KEY não definida`
```powershell
# Adicionar em .env.local
SUPABASE_SERVICE_ROLE_KEY=...
```

### Dev server não inicia

**Erro:** `Port 3000 already in use`
```powershell
# Matar processo
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Ou usar outra porta
npm run dev -- -p 3001
```

### SSE não conecta

**Sintoma:** Console vazio, sem logs `[SSE]`

**Verificar:**
1. Supabase Realtime habilitado:
   - Dashboard → Settings → API
   - Realtime: **ON**
2. Auth funcionando (cookie válido)
3. Teste manual:
   ```powershell
   # Abrir projeto, pegar runId do URL
   # Depois:
   curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true"
   ```

### Arquivos não aparecem

**Sintoma:** SSE conecta, mas arquivos não atualizam

**Verificar:**
1. Worker salvando checkpoint?
   - Ver logs worker: `[Checkpoint] Saved after write`
2. Endpoint `/files` funciona?
   ```powershell
   curl "http://localhost:3000/api/sites/<projectId>/files?run_id=<runId>"
   ```
3. React DevTools: `checkpointPreview` atualiza?

---

## 📊 MONITORAMENTO

### Console Worker
Logs importantes:
```
[Worker] Claimed run: abc-123
[Checkpoint] Saved after write
[Checkpoint] Saved after create
[Worker] Run completed: abc-123
```

### Console DevTools (Browser)
Logs esperados:
```
[SSE] File file_create detected: src/Header.tsx
[Checkpoint] Updated with 2 files
[SSE] File file_write detected: src/App.tsx
[Checkpoint] Updated with 3 files
[SSE] Cleaning up connection
```

### Network Tab
Verificar:
- `activities?stream=true` - Status 200, type `text/event-stream`
- `files?run_id=X` - Status 200, response com `checkpoint`
- Latência <500ms para GET `/files`

---

## 🔍 DEBUG AVANÇADO

### Ver Activities no DB

```sql
SELECT * FROM website_run_activities 
WHERE run_id = '<runId>' 
ORDER BY created_at DESC 
LIMIT 10;
```

### Ver Checkpoint no DB

```sql
SELECT 
  id, 
  status, 
  checkpoint->>'files' as files_count,
  updated_at 
FROM website_runs 
WHERE id = '<runId>';
```

### Ver Mensagens

```sql
SELECT * FROM website_messages 
WHERE run_id = '<runId>' 
ORDER BY created_at DESC 
LIMIT 20;
```

---

## 🛑 PARAR TUDO

```powershell
# Ctrl+C em cada terminal, ou:

# Matar todos os node.exe
taskkill /IM node.exe /F

# Mais gentil: encontrar PIDs e matar
Get-Process node | Select-Object Id,ProcessName
Stop-Process -Id <PID>
```

---

## 🔄 REINICIAR LIMPO

```powershell
# 1. Parar tudo
taskkill /IM node.exe /F

# 2. Limpar cache Next.js
Remove-Item -Recurse -Force .next

# 3. Reinstalar (só se necessário)
Remove-Item -Recurse -Force node_modules
npm install

# 4. Iniciar novamente
npm run sites:worker    # Terminal 1
npm run dev             # Terminal 2
```

---

## 📚 DOCUMENTAÇÃO ADICIONAL

- **Teste manual completo:** `TESTE_REALTIME.md`
- **Implementação técnica:** `IMPLEMENTACAO_COMPLETA.md`
- **Estado do projeto:** `PROJECT_STATE.md`
- **Guia rápido:** `docs/REALTIME_FILES_QUICK_GUIDE.md`

---

## ✅ CHECKLIST DE SAÚDE

Sistema saudável quando:
- [ ] Worker iniciou e aguarda jobs
- [ ] Dev server em http://localhost:3000
- [ ] Console worker sem erros
- [ ] Console browser mostra logs SSE
- [ ] Arquivos aparecem <500ms
- [ ] Preview atualiza automaticamente
- [ ] Testes passam (1607 unit + 36 browser)

---

## 🎯 MODO PRODUÇÃO (Futuro)

Quando subir em produção:

```powershell
# Build
npm run build

# Iniciar
npm start

# Worker (processo separado)
NODE_ENV=production npm run sites:worker
```

**Ajustes necessários:**
- [ ] Configurar Supabase Realtime em prod
- [ ] Variáveis de ambiente em servidor
- [ ] PM2 ou similar para worker
- [ ] Logs estruturados (Winston/Pino)
- [ ] Monitoring (Sentry, DataDog)

---

**Pronto! Sistema 100% funcional e documentado.** 🚀

Em caso de dúvida, ver:
1. Este arquivo primeiro
2. `TESTE_REALTIME.md` depois
3. `PROJECT_STATE.md` para contexto completo
