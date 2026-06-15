# Guia de Integração n8n <> Painel SDR

Este documento explica como configurar seu n8n para que todas as conversas (IA e Humano) sejam sincronizadas em tempo real com o Painel SDR.

---

## 1. Banco de Dados (Supabase)

O Painel lê as mensagens da tabela `n8n_chat_histories`. Certifique-se de que ela existe com esta estrutura:

```sql
CREATE TABLE public.n8n_chat_histories (
  id bigint primary key generated always as identity,
  session_id text not null, -- Use o remoteJid do WhatsApp aqui
  message jsonb not null,    -- Formato: {"type": "ai", "content": "..."} ou {"type": "human", "content": "..."}
  created_at timestamp with time zone default now()
);

-- Ativar Realtime para esta tabela (CRÍTICO para o Chat funcionar ao vivo)
alter publication supabase_realtime add table n8n_chat_histories;
```

**Nota:** No Supabase, vá em **Database** -> **Replication** -> **Source: supabase_realtime** e verifique se a tabela `n8n_chat_histories` está marcada.

---

## 2. Configuração no n8n

### A. Memória da IA (Sarah)
No seu nó de IA (`AI Agent` ou `Chain`), use o nó **PostgreSQL Chat Memory**.
- **User ID:** `={{ $json.remoteJid }}` (ou a variável que contém o número do cliente)
- **Table Name:** `n8n_chat_histories`
- **Session ID Column:** `session_id`
- **Message Column:** `message`

Isso fará com que toda resposta da IA seja salva automaticamente no formato que o painel entende.

### B. Salvar Mensagens Recebidas (Human)
Quando o cliente manda uma mensagem, ela precisa ser salva como `type: human`.
Mesmo que a IA esteja bloqueada (via Redis), você deve ter um nó de **Postgres** (ou Supabase) logo após o Webhook da Evolution API:

**Nó: Salva Histórico Humano**
```json
{
  "session_id": "={{ $json.remoteJid }}",
  "message": {
    "type": "human",
    "content": "={{ $json.message.conversation || $json.message.extendedTextMessage.text || \"[Mídia]\" }}"
  }
}
```

---

## 3. Lógica de Pausa da IA (Supabase - ai_control)

O painel SDR usa a tabela `ai_control` para "bloquear" a IA (Modo Manual). Isso substitui o antigo uso do Redis para deixar o sistema mais leve.

No seu n8n, antes de processar a IA, adicione um nó **Supabase** (ou HTTP Request):

1. **Nó: Verifica Bloqueio (Supabase SELECT)**
   - **Table:** `ai_control`
   - **Filter:** `remote_jid` EQUAL `={{ $json.remoteJid }}`
2. **Nó: IF (Se Bloqueado)**
   - Verifique se `is_paused` é `true`.
   - Verifique se `paused_until` está vazio (Infinito/Manual) OU se é maior que a data atual.
   - Se estiver bloqueado, **PARE** o fluxo.
   - Se não houver registro ou não estiver bloqueado, prossiga para a IA.

---

## 4. Webhook de Leads (Captador)

O Captador do painel agora envia leads para o n8n.
- **URL:** Configure a URL do seu Webhook no painel.
- **Payload:** O painel envia um objeto com:
  ```json
  {
    "nome_do_negocio": "...",
    "telefone": "...",
    "categoria_do_negocio": "...",
    "nicho_pesquisado": "...",
    "regiao_pesquisada": "..."
  }
  ```
Basta usar um nó **Webhook** no n8n para receber e iniciar seu fluxo de prospecção.
