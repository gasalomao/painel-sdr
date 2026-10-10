# ✅ Ícone Google Maps no Header do Chat

**Data:** 10/10/2026  
**Requisito:** Ícone discreto do Google Maps ao lado do nome do contato no chat

---

## 🎯 Implementação

### Funcionalidade

Quando um lead vinculado ao contato tem `maps_url` (link do Google Maps), aparece um ícone discreto ao lado do nome no header do chat. Clicando no ícone, abre o Google Maps em nova aba.

### Localização Visual

**Onde aparece:** Header do chat, ao lado direito do nome do contato  
**Estilo:** Ícone azul discreto (MapPin), 20x20px, hover suave  
**Tooltip:** Mostra o endereço do lead (se disponível)

---

## 📁 Arquivos Modificados

### 1. `src/components/inbox/message-thread.tsx`

**Mudanças:**
- Adicionado import `MapPin` do lucide-react
- Adicionada prop `lead` na interface `MessageThreadProps`
- Adicionado ícone condicional ao lado do nome:

```typescript
{lead?.maps_url && (
  <a
    href={lead.maps_url}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center justify-center h-5 w-5 rounded-md bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 hover:text-blue-600 transition-colors shrink-0"
    title={lead.endereco || "Ver no Google Maps"}
  >
    <MapPin className="h-3 w-3" />
  </a>
)}
```

### 2. `src/app/chat/page.tsx`

**Mudanças:**
- Adicionado estado `activeLead` para armazenar dados do lead ativo
- Adicionado `useEffect` para buscar lead quando `activeContact` muda
- Busca lead por `lead_id` (preferencial) ou por `telefone` (fallback)
- Limpa `activeLead` ao fechar conversa
- Passa `lead={activeLead}` para `<MessageThread>`

**Query do Lead:**
```typescript
supabase
  .from("leads_extraidos")
  .select("maps_url, lat, lng, endereco")
  .eq("client_id", clientId)
  .eq("id", lead_id) // ou .eq("telefone", phoneClean)
  .maybeSingle()
```

---

## 🎨 Design

### Estilo do Ícone

- **Tamanho:** 20x20px (não invasivo)
- **Cor:** Azul (#3B82F6) com fundo translúcido
- **Hover:** Fundo mais escuro + cor mais intensa
- **Posicionamento:** `gap-2` do nome (espaçamento natural)

### Comportamento

- ✅ Só aparece se `lead.maps_url` existir
- ✅ Abre em nova aba (`target="_blank"`)
- ✅ Tooltip mostra endereço (se disponível)
- ✅ Click não interfere com o chat (`stopPropagation` não necessário no link externo)

---

## 🔍 Dados Utilizados

### Campos do Lead

| Campo | Tipo | Uso |
|-------|------|-----|
| `maps_url` | string | Link para abrir no Google Maps |
| `endereco` | string | Tooltip do ícone |
| `lat` | number | (Disponível, não usado ainda) |
| `lng` | number | (Disponível, não usado ainda) |

### Fonte dos Dados

- **Tabela:** `leads_extraidos`
- **Migration:** `011_leads_maps_deepfields.sql`
- **Origem:** Captador de Maps (já preenchido)

---

## ✅ Vantagens

1. **Discreto:** Ícone pequeno, não polui visualmente
2. **Contextual:** Só aparece quando há localização
3. **Rápido:** Um clique abre o Maps
4. **Informativo:** Tooltip mostra endereço
5. **Consistente:** Mesmo padrão visual do sistema

---

## 🧪 Como Testar

1. Abrir chat com um contato que tem lead vinculado
2. Lead deve ter `maps_url` preenchido (vem do Captador Maps)
3. Verificar ícone azul ao lado do nome do contato
4. Hover: ver tooltip com endereço
5. Clicar: deve abrir Google Maps em nova aba

---

## 📊 Exemplo Visual

```
┌─────────────────────────────────────┐
│  [Avatar] Wglass Vidraçaria 🗺️      │ ← Ícone aqui
│           Conexão: easepanel_05_13   │
└─────────────────────────────────────┘
```

---

## 🚀 Status

✅ **Implementado**  
🔄 **Build em andamento**  
⏳ **Aguardando validação visual**

---

**Última Atualização:** 10/10/2026 17:35 BRT
