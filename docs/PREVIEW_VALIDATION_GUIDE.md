# Guia de Validação do Preview - Site Studio

## Objetivo

Documentar as regras que o agente IA DEVE seguir para garantir que todo site gerado possa ser renderizado corretamente no preview.

---

## ✅ ESTRUTURA OBRIGATÓRIA

### Arquivos Essenciais (NUNCA OMITIR)

O preview exige exatamente 3 arquivos principais:

```typescript
// Validação em src/components/sites/site-preview.tsx:323
if (!["index.html", "src/main.tsx", "src/App.tsx"].every(path => 
  files[path]?.trim()
)) {
  // PREVIEW FALHA COM: "Rascunho incompleto. Crie ou corrija os arquivos de entrada."
}
```

#### 1. `index.html` - Entry HTML

**Obrigatório:**
- `<!doctype html>`
- `<html lang="pt-BR">`
- `<meta charset="UTF-8">`
- `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
- `<div id="root"></div>`
- `<script type="module" src="/src/main.tsx"></script>`

**Exemplo mínimo:**
```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nome do Site</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### 2. `src/main.tsx` - Entry React

**Obrigatório:**
- Import React e createRoot
- Import do componente App
- createRoot no elemento #root
- Render com StrictMode

**Exemplo mínimo:**
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

#### 3. `src/App.tsx` - Componente Raiz

**Obrigatório:**
- Export default de uma função
- Retornar JSX válido

**Exemplo mínimo:**
```tsx
export default function App() {
  return (
    <main>
      <h1>Bem-vindo</h1>
    </main>
  );
}
```

---

## 🚫 RESTRIÇÕES CRÍTICAS

### 1. Paths Permitidos

Apenas arquivos em `src/` e `public/` são processados:

```typescript
// src/components/sites/site-preview.tsx:26
if (normalized.startsWith("src/") || normalized.startsWith("public/")) {
  result[`/${normalized}`] = { code: previewCode };
}
// Arquivos fora dessas pastas são IGNORADOS silenciosamente
```

**✅ Permitido:**
- `src/App.tsx`
- `src/components/Header.tsx`
- `src/styles.css`
- `public/logo.png`

**❌ Bloqueado (ignorado):**
- `components/Header.tsx` (sem src/)
- `App.tsx` (na raiz)
- `lib/utils.ts` (fora de src/)
- `assets/logo.png` (use /assets/{uuid}.ext)

### 2. Comentários HTML em JSX

Comentários HTML causam erro fatal de Babel:

```typescript
// src/components/sites/site-preview.tsx:29-31
if (/\.(tsx|jsx)$/.test(normalized)) {
  previewCode = previewCode.replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}");
}
```

**❌ NUNCA usar:**
```tsx
export default function App() {
  return (
    <div>
      <!-- Isso quebra o preview! -->
      <h1>Título</h1>
    </div>
  );
}
```

**✅ Sempre usar:**
```tsx
export default function App() {
  return (
    <div>
      {/* Isso funciona corretamente */}
      <h1>Título</h1>
    </div>
  );
}
```

### 3. Dependências Fixas

Apenas estas dependências estão disponíveis:

```typescript
// src/lib/sites/starter.ts:4 (WEBSITE_FIXED_FILES)
{
  "dependencies": {
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "typescript": "5.9.3",
    "vite": "6.4.1"
  }
}
```

**✅ Permitido:**
- `import { useState, useEffect } from "react"`
- `import { createRoot } from "react-dom/client"`

**❌ Bloqueado:**
- `import axios from "axios"` (não está em dependencies)
- `import { Button } from "@/components/ui/button"` (sem shadcn/ui)
- `import clsx from "clsx"` (não disponível)

### 4. Assets e Imagens

Use apenas o formato de assets do sistema:

**✅ Correto:**
```tsx
<img src="/assets/550e8400-e29b-41d4-a716-446655440000.png" alt="Logo" />
```

**❌ Incorreto:**
```tsx
<img src="https://example.com/logo.png" alt="Logo" />
<img src="/logo.png" alt="Logo" />
<img src="./assets/logo.png" alt="Logo" />
```

O sistema substitui `/assets/{uuid}.{ext}` por URLs assinadas automaticamente:

```typescript
// src/lib/sites/asset-preview.ts:38-41
result = result.replace(assetReference, (match, prefix, assetPath, _id, _query, fragment) => {
  const url = urls.get(assetPath);
  return url ? `${prefix}${url}${fragment ?? ""}` : match;
});
```

---

## ⏱️ TIMEOUT DE RENDERIZAÇÃO

O preview tem 60 segundos para montar:

```typescript
// src/components/sites/site-preview.tsx:179
let remaining = 60_000; // 60s
timer = setTimeout(() => 
  onResult(candidateId, "failed", 
    "Não foi possível confirmar a montagem inicial do site."
  ), 
  remaining
);
```

**Evite:**
- Processamento pesado no mount (useEffect inicial)
- Fetch síncrono de muitos recursos
- Loops ou recursão no render
- Bibliotecas com inicialização lenta

**Prefira:**
- Estados iniciais simples
- Lazy loading de imagens
- Dados inline via JSON
- Componentes leves

---

## 📝 PROMPT DO AGENTE IA

### Instruções Injetadas no System Prompt

O agente recebe estas instruções em `src/lib/sites/prompts.ts:240`:

```typescript
`EXECUÇÃO: ${surgical 
  ? "somente patch literal único, inspeção e validação estática" 
  : "aplique mudanças nos arquivos virtuais com create/write/patch/delete"
}. Use React, TypeScript e CSS e apenas dependências fixas.`
```

### Validações de Segurança

```typescript
// src/lib/sites/prompts.ts:235
WEBSITE_SECURITY_PROMPT
```

Este prompt inclui:
- Proibição de scripts externos
- Validação de paths
- Sanitização de inputs
- Prevenção de XSS

---

## 🧪 CHECKLIST DE VALIDAÇÃO

### Antes de Gerar (Agente IA)

- [ ] Confirmar estrutura obrigatória (3 arquivos)
- [ ] Verificar paths começam com `src/` ou `public/`
- [ ] Usar apenas React + TypeScript
- [ ] Não importar bibliotecas externas
- [ ] Assets no formato `/assets/{uuid}.{ext}`
- [ ] Comentários JSX (não HTML)
- [ ] Entry point correto em index.html

### Durante Geração (Sistema)

- [ ] Normalizar paths (remover `/` inicial)
- [ ] Auto-converter `<!-- -->` para `{/* */}` em JSX
- [ ] Validar UUIDs de assets
- [ ] Substituir assets por URLs assinadas
- [ ] Remover scripts do HTML parseado
- [ ] Injetar probe de renderização

### Após Renderização (Preview)

- [ ] Monitorar timeout (60s)
- [ ] Capturar erros de runtime
- [ ] Detectar promessas rejeitadas
- [ ] Verificar montagem do React
- [ ] Confirmar ausência de erros visuais

---

## 🔧 FERRAMENTAS DE DEBUGGING

### Logs do Preview

O preview emite eventos via postMessage:

```typescript
// src/components/sites/site-preview.tsx:54-56
const notify = (status, message) => {
  window.parent.postMessage(
    { type: "preview-candidate", id: candidateId, status, message },
    origin
  );
};
```

**Status possíveis:**
- `"ready"` - Site montou com sucesso
- `"failed"` - Erro na execução

### Error Banner

Erros são exibidos inline no preview:

```typescript
// src/components/sites/site-preview.tsx:64-80
const showError = (error) => {
  // Cria banner vermelho no topo do preview
  // Mostra mensagem de erro (max 2000 chars)
  // Envia status "failed" via postMessage
};
```

### Estados do Preview

```typescript
// src/components/sites/site-preview.tsx:225-226
type Attempt = { id: string; version: string; files: SandpackFiles };
state: { 
  accepted: Attempt | null,  // Preview válido atual
  pending: Attempt | null,   // Novo preview carregando
  requested: string,         // Versão solicitada
  error: string              // Erro atual
}
```

---

## 🚀 MELHORIAS IMPLEMENTADAS

### Auto-Sanitização JSX

```typescript
// src/components/sites/site-preview.tsx:29-31
if (/\.(tsx|jsx)$/.test(normalized)) {
  previewCode = previewCode.replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}");
}
```

Converte automaticamente comentários HTML para JSX.

### Retained Preview

Mantém último preview válido enquanto novo carrega:

```typescript
// src/components/sites/site-preview.tsx:258-260
{[state.accepted, state.pending]
  .filter(attempt => Boolean(attempt))
  .map(attempt => {
    const pending = attempt.id === state.pending?.id;
    // Renderiza ambos, mas pending fica opaco e inert
  })
}
```

### Error Recovery

Captura todos os erros possíveis:

```typescript
// src/components/sites/site-preview.tsx:82-108
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);
if (hot) hot.addStatusHandler(onStatus);
```

---

## 📚 EXEMPLOS PRÁTICOS

### Exemplo 1: Site Mínimo Válido

```typescript
// index.html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Meu Site</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>

// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// src/App.tsx
export default function App() {
  return <h1>Hello World</h1>;
}
```

### Exemplo 2: Site com CSS e Componentes

```typescript
// src/App.tsx
import { Header } from "./components/Header";
import "./styles.css";

export default function App() {
  return (
    <>
      <Header title="Meu Site" />
      <main>
        <h1>Bem-vindo</h1>
      </main>
    </>
  );
}

// src/components/Header.tsx
export function Header({ title }: { title: string }) {
  return (
    <header className="header">
      <h1>{title}</h1>
    </header>
  );
}

// src/styles.css
.header {
  background: #333;
  color: white;
  padding: 1rem;
}
```

### Exemplo 3: Site com Assets

```typescript
// src/App.tsx
export default function App() {
  return (
    <div>
      <img 
        src="/assets/550e8400-e29b-41d4-a716-446655440000.png" 
        alt="Logo"
        width={200}
        height={100}
      />
      <h1>Empresa ABC</h1>
    </div>
  );
}
```

---

## 🎯 RESUMO EXECUTIVO

### Para o Agente IA

**SEMPRE:**
1. Gerar `index.html`, `src/main.tsx`, `src/App.tsx`
2. Paths começam com `src/` ou `public/`
3. Usar apenas React + TypeScript
4. Comentários JSX: `{/* ... */}`
5. Assets: `/assets/{uuid}.{ext}`

**NUNCA:**
1. Arquivos fora de `src/` e `public/`
2. Comentários HTML: `<!-- ... -->`
3. Imports de bibliotecas não listadas
4. URLs externas inline
5. Processamento pesado no mount

### Para o Sistema

**VALIDAÇÕES:**
1. ✅ Estrutura obrigatória presente
2. ✅ Paths normalizados
3. ✅ HTML comments convertidos
4. ✅ Assets com UUIDs válidos
5. ✅ Timeout configurado (60s)

**ERRO RECOVERY:**
1. ✅ Manter último preview válido
2. ✅ Capturar todos os erros
3. ✅ Feedback claro ao usuário
4. ✅ Cleanup robusto

---

**Última atualização:** 09/10/2026 01:30  
**Versão:** 1.0  
**Status:** ✅ PRODUÇÃO
