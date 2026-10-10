# 🔒 CORREÇÃO CRÍTICA DE SEGURANÇA: Vazamento de Thinking/Reasoning

**Data:** 10/10/2026  
**Severidade:** 🔴 CRÍTICA  
**Impacto:** Vazamento de prompt do sistema, exposição de regras internas da IA, respostas em inglês quando deveria ser português

---

## 📋 Problema Identificado

A IA do chat estava **expondo seu raciocínio interno** diretamente para os clientes no WhatsApp, revelando:

- ✗ Regras do sistema prompt em inglês
- ✗ Lógica de decisão interna ("But let's check the anti-hallucination rules...")
- ✗ Instruções confidenciais ("In the core instructions, under 'Adaptação do Método BANT'...")
- ✗ Pensamentos do modelo que não deveriam ser visíveis ao usuário

### Exemplo Real do Bug

```
[Cliente recebe no WhatsApp]
But let's check the anti-hallucination rules: don't invent info. The lead context says "Status no CRM: primeiro_contato", so this is the very first interaction after the initial disparo message.

In the core instructions, under "Adaptação do Método BANT", Authority is: "A conversa é com o responsável pelo negócio..." So Sarah should aim to talk to the decision-maker.

Therefore, her response should be to politely ask to speak with the person in charge, while maintaining her helpful, consultative tone.
```

**Impacto:** Cliente vê toda a "cozinha" da IA em vez de receber uma resposta profissional em português.

---

## 🔍 Causa Raiz

No arquivo `src/lib/ai-provider.ts`, função `requireUsableOpenAIResponse()`:

```typescript
// ❌ CÓDIGO VULNERÁVEL (ANTES)
function requireUsableOpenAIResponse(json: any, provider: AiProvider, model: string): any {
  const message = json?.choices?.[0]?.message || {};
  const reasoning = String(message.reasoning_content || message.reasoning || message.thought || "").trim();
  if (!message.content && reasoning) {
    message.content = reasoning;  // 💥 VAZAMENTO AQUI!
  }
  // ...
}
```

Quando um modelo retornava:
- `reasoning_content` (pensamento interno) **SEM** `content` (resposta final)
- O código **substituía** o content pelo reasoning
- O raciocínio interno vazava diretamente para o usuário final

---

## ✅ Solução Implementada

```typescript
// ✅ CÓDIGO CORRIGIDO (DEPOIS)
function requireUsableOpenAIResponse(json: any, provider: AiProvider, model: string): any {
  const message = json?.choices?.[0]?.message || {};
  // SECURITY FIX: NUNCA vazar reasoning/thinking interno pro content final.
  // reasoning_content/reasoning/thought são PENSAMENTO INTERNO do modelo — não
  // podem ir pro usuário (expõe regras do sistema, vazamento de prompt, resposta
  // em inglês quando deveria ser português). Se o modelo só retornou thinking sem
  // content real, é resposta VAZIA (AiEmptyResponseError) — nunca substituir.
  const hasText = String(message.content || "").trim().length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (!hasText && !hasTools) {
    throw new AiEmptyResponseError(provider, model, openRouterUsage(json, provider, model));
  }
  return json;
}
```

### Mudanças:

1. **Removida** a lógica que copiava `reasoning` para `content`
2. **Adicionada** validação: se não há `content` real, lança `AiEmptyResponseError`
3. **Ignorado** completamente o campo `reasoning/thinking` — nunca deve vazar para o usuário

---

## 🧪 Testes de Segurança

Criado arquivo `src/lib/__tests__/ai-provider-thinking-leak.test.ts` com 7 testes:

### Casos Cobertos:

1. ✅ **Rejeita** resposta que só tem `reasoning_content` sem `content` real
2. ✅ **Rejeita** resposta que só tem `reasoning` sem `content` real
3. ✅ **Rejeita** resposta que só tem `thought` sem `content` real
4. ✅ **Aceita** resposta com `content` real (reasoning presente é ignorado)
5. ✅ **Aceita** resposta com `tool_calls` mesmo sem content (chamada de função)
6. ✅ **Rejeita** resposta completamente vazia
7. ✅ **NEVER** substituir `content` por `reasoning` (comportamento proibido)

### Resultado dos Testes:

```
✓ src/lib/__tests__/ai-provider-thinking-leak.test.ts (7 tests) 13ms
✓ src/lib/__tests__/ai-provider.test.ts (26 tests) 1696ms

Test Files  2 passed (2)
     Tests  33 passed (33)
```

---

## 🎯 Resultado Final

### Antes:
```
[Cliente recebe]
But let's check the anti-hallucination rules: don't invent info...
In the core instructions, under "Adaptação do Método BANT"...
Therefore, her response should be to politely ask...
```

### Depois:
```
[Cliente recebe]
Olá! Obrigada pelo contato. Gostaria de falar com o responsável 
pela empresa para apresentar nossa solução. Ele está disponível?
```

---

## 📌 Checklist de Validação

- [x] Bug identificado e documentado
- [x] Causa raiz encontrada (linha 486-487 de `ai-provider.ts`)
- [x] Correção implementada (remover lógica de vazamento)
- [x] Testes de segurança criados (7 casos)
- [x] Testes passando (100% sucesso)
- [x] Testes de regressão passando (26 testes do ai-provider)
- [x] Documentação criada

---

## 🚨 Prevenção Futura

### Regras de Ouro:

1. **NUNCA** copiar campos `reasoning`, `reasoning_content`, `thought`, `thinking` para `content`
2. **SEMPRE** tratar reasoning como **metadado interno**, não como resposta ao usuário
3. **SEMPRE** validar que `content` tem texto real antes de enviar ao cliente
4. **SE** não houver `content` nem `tool_calls`, lançar `AiEmptyResponseError` e tentar novamente

### Monitoramento:

- Revisar logs de chat procurando por padrões em inglês quando deveria ser português
- Alertar quando mensagens contêm termos como "instructions", "reasoning", "anti-hallucination"
- Validar que respostas seguem o tom esperado (Sarah em português, não explicações técnicas em inglês)

---

## 📞 Contato

Se observar comportamento similar (IA expondo raciocínio interno), reportar imediatamente como **incidente de segurança crítico**.

**Arquivos Modificados:**
- `src/lib/ai-provider.ts` (linha 483-495)
- `src/lib/__tests__/ai-provider-thinking-leak.test.ts` (novo)
- `docs/SECURITY_FIX_THINKING_LEAK.md` (este arquivo)
