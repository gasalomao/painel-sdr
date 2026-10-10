# 🔍 Monitoramento: Vazamento de Thinking/Reasoning

**Objetivo:** Detectar e prevenir que raciocínio interno da IA vaze para usuários finais.

---

## 🚨 Sinais de Alerta

### Indicadores Críticos (Ação Imediata)

Mensagens de chat contendo:

- ✗ `"But let's check the"` / `"But wait"`
- ✗ `"In the core instructions"`
- ✗ `"The lead context says"`
- ✗ `"Therefore, her response should be"`
- ✗ `"anti-hallucination rules"`
- ✗ `"Adaptação do Método BANT"`
- ✗ Qualquer citação de nomes de seções do prompt do sistema

### Indicadores de Atenção

- ⚠️ Mensagens predominantemente em **inglês** quando o prompt está em **português**
- ⚠️ Respostas que explicam o próprio raciocínio em vez de responder diretamente
- ⚠️ Menções a "decision-maker", "Authority", "Budget" (termos do BANT em inglês)
- ⚠️ Frases que soam como "meta-conversa" sobre como responder

---

## 📊 Query de Monitoramento SQL

```sql
-- Detectar possível vazamento de thinking em mensagens da IA
SELECT 
  cd.id,
  cd.client_id,
  cd.conversation_id,
  cd.remote_jid,
  cd.content,
  cd.created_at,
  cd.is_from_me
FROM chats_dashboard cd
WHERE 
  cd.is_from_me = true  -- Mensagens enviadas pela IA
  AND cd.created_at > NOW() - INTERVAL '7 days'
  AND (
    -- Padrões de vazamento de thinking
    cd.content ILIKE '%But let''s check%'
    OR cd.content ILIKE '%But wait%'
    OR cd.content ILIKE '%In the core instructions%'
    OR cd.content ILIKE '%Therefore, her response should%'
    OR cd.content ILIKE '%anti-hallucination%'
    OR cd.content ILIKE '%The lead context says%'
    OR cd.content ILIKE '%decision-maker%'
    OR cd.content ILIKE '%Adaptação do Método BANT%'
    
    -- Detecção de inglês quando deveria ser português
    OR (
      cd.content ~ '[A-Z][a-z]+ (should|could|would|must) '
      AND cd.content !~ 'Olá|obrigad|por favor|gostaria'
    )
  )
ORDER BY cd.created_at DESC
LIMIT 50;
```

### Query de Auditoria (Executar Diariamente)

```sql
-- Estatísticas de possível vazamento por dia
SELECT 
  DATE(cd.created_at) as data,
  COUNT(*) as total_mensagens_ia,
  COUNT(*) FILTER (WHERE cd.content ILIKE '%But let''s check%' OR cd.content ILIKE '%In the core instructions%') as possiveis_vazamentos,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE cd.content ILIKE '%But let''s check%' OR cd.content ILIKE '%In the core instructions%') / NULLIF(COUNT(*), 0),
    2
  ) as percentual_vazamento
FROM chats_dashboard cd
WHERE 
  cd.is_from_me = true
  AND cd.created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(cd.created_at)
ORDER BY data DESC;
```

---

## 🔧 Pontos de Validação no Código

### 1. Extração de Resposta (ai-provider.ts)

**Linha crítica:** `requireUsableOpenAIResponse()` (linha ~483)

✅ **Validação correta:**
```typescript
// NUNCA copiar reasoning para content
const hasText = String(message.content || "").trim().length > 0;
const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
if (!hasText && !hasTools) {
  throw new AiEmptyResponseError(provider, model, openRouterUsage(json, provider, model));
}
```

❌ **Padrão proibido:**
```typescript
// NUNCA FAZER ISSO:
if (!message.content && reasoning) {
  message.content = reasoning;  // ❌ VAZAMENTO!
}
```

### 2. Processamento de Chat (agent/process/route.ts)

**Linha crítica:** Onde `turn.text` é usado (~2590)

Validar que o texto final:
- Está em português (quando configurado)
- Não contém meta-explicações sobre o raciocínio
- Responde diretamente ao usuário

### 3. Formatação de Mensagem (agent-format.ts)

Validar que `resolveAgentOutput()` não injeta thinking inadvertidamente.

---

## 🧪 Testes Automáticos

### Teste de Regressão (Executar em CI/CD)

```bash
npm test -- src/lib/__tests__/ai-provider-thinking-leak.test.ts
```

**Deve passar 100%:**
- ✅ 7/7 testes de segurança
- ✅ Rejeita respostas que só têm reasoning
- ✅ Aceita respostas com content real
- ✅ NEVER substitui content por reasoning

### Teste de Integração Manual

**Cenário:** Enviar mensagem teste via Evolution API

```bash
curl -X POST https://sistema-sdr.irdmi.easypanel.host/api/agent/process \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_SECRET" \
  -d '{
    "clientId": "test-client",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "instanceName": "teste",
    "messageContent": "Olá, quero saber sobre os serviços"
  }'
```

**Validar resposta:**
- ✅ Em português
- ✅ Sem menções a "instructions", "reasoning", "But let's check"
- ✅ Tom natural (Sarah SDR, não meta-explicação)

---

## 📋 Checklist de Deploy

Antes de cada deploy:

- [ ] Testes de thinking leak passando (7/7)
- [ ] Testes gerais do ai-provider passando (26/26)
- [ ] Query de auditoria SQL executada (0 vazamentos nos últimos 7 dias)
- [ ] Teste manual de integração realizado
- [ ] Revisão de código focada em extração de `message.content`

---

## 🚑 Procedimento de Resposta a Incidente

**Se detectar vazamento de thinking:**

1. **PARAR** - Pausar agente IA afetado imediatamente
   ```sql
   UPDATE agents SET is_active = false WHERE id = <agent_id>;
   ```

2. **INVESTIGAR** - Capturar logs completos
   ```sql
   SELECT * FROM chats_dashboard 
   WHERE conversation_id = '<conversation_id>' 
   ORDER BY created_at DESC 
   LIMIT 100;
   ```

3. **CORRIGIR** - Verificar versão do código
   - Confirmar que `ai-provider.ts` está na versão corrigida
   - Checar se houve rollback acidental
   - Revisar mudanças recentes relacionadas a reasoning

4. **VALIDAR** - Executar suite de testes
   ```bash
   npm test -- src/lib/__tests__/ai-provider-thinking-leak.test.ts
   npm test -- src/lib/__tests__/ai-provider.test.ts
   ```

5. **REATIVAR** - Somente após confirmação
   ```sql
   UPDATE agents SET is_active = true WHERE id = <agent_id>;
   ```

6. **DOCUMENTAR** - Adicionar ao log de incidentes
   - Data/hora da detecção
   - Número de mensagens afetadas
   - Causa raiz identificada
   - Ação corretiva tomada
   - Tempo de resolução

---

## 📞 Contato de Emergência

**Severidade:** 🔴 CRÍTICA - Security & Privacy Breach

**Time de Resposta:** Imediato

**Responsável:** Desenvolvedor Principal / DevOps

---

## 📚 Referências

- `docs/SECURITY_FIX_THINKING_LEAK.md` - Documentação da correção original
- `src/lib/__tests__/ai-provider-thinking-leak.test.ts` - Suite de testes
- `src/lib/ai-provider.ts` - Código corrigido (linha 483-495)

**Última Atualização:** 10/10/2026
