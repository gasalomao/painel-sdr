# ⚡ Guia Rápido - Site Studio

> Referência rápida para desenvolvimento e uso do sistema Site Studio

---

## 🚀 Início Rápido

### Para Usuários

```bash
1. Acesse /sites
2. Clique em "Criar site"
3. Preencha dados do cliente
4. Envie mensagem: "Crie um site moderno para [negócio]"
5. Aguarde conclusão
6. Clique em "Publicar"
```

### Para Desenvolvedores

```bash
# Instalar dependências
npm install

# Configurar ambiente
cp .env.example .env.local
# Preencha as variáveis obrigatórias

# Executar em desenvolvimento
npm run dev

# Rodar testes
npm test

# Build de produção
npm run build
```

---

## 📋 Comandos Essenciais

### Criar Projeto
```typescript
POST /api/sites
{
  "name": "Nome do Site",
  "client_context": { "name": "Cliente", "segment": "Segmento" },
  "instructions": "Instruções específicas",
  "model_mode": "quality",
  "cta": { "type": "whatsapp", "value": "5511999999999" }
}
```

### Enviar Mensagem
```typescript
POST /api/sites/[id]/chat
{
  "message": "Mude a cor principal para azul",
  "asset_ids": ["uuid-do-asset"],  // Opcional
  "model_id": "anthropic/claude-3.5-sonnet"  // Opcional
}
```

### Publicar Site
```typescript
POST /api/sites/[id]/deploy
{
  "revision_id": "uuid-da-revisao"
}
```

---

## 🛠️ Ferramentas do Agente (Cheat Sheet)

### Leitura
```typescript
list()                           // Lista todos os arquivos
read({ path, start_line, end_line })  // Lê linhas específicas
read_files({ paths: [] })        // Lê múltiplos arquivos
search({ query, path? })         // Busca texto
get_context()                    // Retorna contexto do projeto
assets()                         // Lista assets disponíveis
```

### Escrita
```typescript
create({ path, content })        // Cria novo arquivo
write({ path, content })         // Substitui arquivo completo
patch({ path, old, new })        // ⭐ Patch cirúrgico (preferencial)
delete({ path })                 // Remove arquivo
rename({ path, to })             // Renomeia arquivo
```

### Gestão
```typescript
checkpoint({ name })             // Salva estado atual
restore({ name })                // Restaura checkpoint
run_validation()                 // Valida código estaticamente
```

### Impeccable (quando ativa)
```typescript
read_design_reference({ name, offset, limit })
record_design_direction({ mode, palette, typography, ... })
```

---

## 🎨 Prompt Templates

### Site Básico
```
Crie um site moderno para [negócio] com:
- Home: apresentação e CTA
- Serviços: lista dos principais serviços
- Sobre: história e diferenciais
- Contato: formulário e localização
```

### Edição de Cor
```
Mude a cor primária para [cor] (#hex)
```

### Edição de Texto
```
No [seção], troque "[texto antigo]" por "[texto novo]"
```

### Adicionar Logo
```
Adicione o logo no cabeçalho, centralizado, com 120px de altura
```

### Redesign
```
Refaça o site com estilo [minimalista/moderno/elegante]:
- Paleta: [cores]
- Tipografia: [fontes]
- Layout: [estrutura]
```

---

## 🔍 Debug Rápido

### Ver Status do Run
```typescript
const run = await fetch(`/api/sites/${projectId}/runs/${runId}`).then(r => r.json());
console.log(run.status, run.error);
```

### Ver Mensagens
```typescript
const messages = await fetch(`/api/sites/${projectId}/messages`).then(r => r.json());
console.log(messages.messages);
```

### Verificar Build
```typescript
const builds = await fetch(`/api/sites/${projectId}/builds`).then(r => r.json());
console.log(builds.builds[0]);
```

### Cancelar Run Travado
```typescript
await fetch(`/api/sites/${projectId}/runs/${runId}/cancel`, { method: 'POST' });
```

---

## ⚠️ Erros Comuns

### "Budget exceeded"
**Causa**: Limite de tokens/rodadas atingido  
**Solução**: Simplifique o pedido ou use modelo economy

### "Build failed"
**Causa**: Erro de sintaxe no código gerado  
**Solução**: Agent corrige automaticamente; aguarde 2ª tentativa

### "Patch only mode"
**Causa**: Pedido complexo em modo cirúrgico  
**Solução**: Use termos como "crie", "refaça" para sair do modo

### "Origin not authorized"
**Causa**: Requisição de origem inválida  
**Solução**: Verifique CORS e origin headers

### "No compatible model"
**Causa**: Nenhum modelo disponível suporta a requisição  
**Solução**: Verifique API keys e model_allowlist

---

## 📊 Limites Importantes

```typescript
Arquivos:        50 max
Tamanho/arquivo: 200KB
Total arquivos:  3MB
Assets/run:      12 max
Rodadas normal:  12 max
Rodadas patch:   3 max
Tokens normal:   800k max
Tokens patch:    60k max
Checkpoints:     6 max
Histórico:       20 mensagens
```

---

## 🎯 Modos de Operação

### Modo Normal (Agent)
- Site novo OU mudanças estruturais
- Até 12 rodadas
- 800k tokens total
- Todas as ferramentas disponíveis

### Modo Patch Only (Cirúrgico)
- Site existente + pedido simples
- Até 3 rodadas
- 60k tokens total
- Apenas leitura e patch

### Modo Build
- Validação isolada
- 1 rodada
- Sem edição de arquivos

---

## 🔐 Variáveis de Ambiente Essenciais

```env
# Obrigatórias
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
E2B_API_KEY=
E2B_SITE_TEMPLATE_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
OPENROUTER_API_KEY=

# Recomendadas
NEXT_PUBLIC_APP_URL=http://localhost:3000
NODE_ENV=development
```

---

## 🧪 Testes Rápidos

```bash
# Todos os testes
npm test

# Específico
npm test agent.test.ts

# Com coverage
npm test -- --coverage

# Watch mode
npm test -- --watch
```

---

## 📦 Estrutura de Arquivos Gerados

```
site-gerado/
├── index.html              # Página principal
├── package.json            # Dependências (fixas)
├── tsconfig.json           # Config TypeScript
├── vite.config.ts          # Config Vite
└── src/
    ├── App.tsx             # Componente raiz
    ├── tokens.css          # Design tokens
    ├── styles.css          # Estilos globais
    └── components/         # Componentes customizados
        ├── Header.tsx
        ├── Footer.tsx
        └── ...
```

---

## 🎨 Design Tokens Padrão

```css
/* src/tokens.css */
:root {
  /* Cores */
  --color-primary: #000;
  --color-secondary: #666;
  --color-accent: #3B82F6;
  --color-surface: #fff;
  --color-text: #000;
  
  /* Tipografia */
  --font-sans: system-ui, sans-serif;
  --font-display: system-ui, sans-serif;
  --text-xs: clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem);
  --text-base: clamp(1rem, 0.92rem + 0.4vw, 1.125rem);
  --text-lg: clamp(1.25rem, 1.1rem + 0.75vw, 1.5rem);
  --text-xl: clamp(1.5rem, 1.2rem + 1.5vw, 2rem);
  --text-display: clamp(3rem, 1rem + 7vw, 8rem);
  
  /* Espaçamentos */
  --space-xs: clamp(0.5rem, 0.4rem + 0.5vw, 0.75rem);
  --space-sm: clamp(1rem, 0.8rem + 1vw, 1.5rem);
  --space-md: clamp(2rem, 1.5rem + 2.5vw, 3rem);
  --space-lg: clamp(3rem, 2rem + 5vw, 5rem);
  --space-xl: clamp(4rem, 3rem + 5vw, 10rem);
  
  /* Raios */
  --radius-sm: 0.5rem;
  --radius-md: 1rem;
  --radius-lg: 2rem;
  --radius-pill: 999px;
  
  /* Sombras */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.1);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
}
```

---

## 🚀 Performance Checklist

### Frontend
- [ ] Imagens otimizadas (WebP, lazy loading)
- [ ] Fonts preloaded
- [ ] CSS inline crítico
- [ ] JS code splitting
- [ ] Service Worker (opcional)

### Backend
- [ ] Cache de queries Supabase
- [ ] Índices no banco
- [ ] Timeouts configurados
- [ ] Rate limiting
- [ ] Logs estruturados

---

## 📱 Responsividade

```css
/* Breakpoints recomendados */
@media (max-width: 640px)  { /* Mobile */ }
@media (max-width: 768px)  { /* Tablet */ }
@media (max-width: 1024px) { /* Desktop small */ }
@media (max-width: 1280px) { /* Desktop medium */ }
@media (min-width: 1281px) { /* Desktop large */ }
```

---

## 🔄 Fluxo de Deploy

```
1. User: "Publicar site"
   ↓
2. Sistema valida revisão atual
   ↓
3. Faz build completo no E2B
   ↓
4. Gera artifact (ZIP)
   ↓
5. Envia para Cloudflare Pages
   ↓
6. Aguarda deploy
   ↓
7. Atualiza URL pública no projeto
   ↓
8. Notifica usuário
```

---

## 🎓 Skills Úteis

### Design Patterns
```typescript
{
  name: "Minimalista Premium",
  tags: ["minimalista", "clean", "premium"],
  trigger_mode: "automatic"
}
```

### SEO Básico
```typescript
{
  name: "SEO Essencial",
  tags: ["seo", "google", "otimização"],
  trigger_mode: "always"
}
```

### Acessibilidade
```typescript
{
  name: "WCAG AA",
  tags: ["acessibilidade", "a11y", "wcag"],
  trigger_mode: "always"
}
```

---

## 📞 Contatos e Recursos

### Documentação
- [Documentação Completa](./DOCUMENTACAO_SITE_STUDIO.md)
- [E2B Docs](https://e2b.dev/docs)
- [Cloudflare Pages](https://pages.cloudflare.com)
- [OpenRouter](https://openrouter.ai/docs)

### Repositórios
- Site Studio: (interno)
- E2B Template: `website-builder-v1`

---

## 🎯 Próximos Passos

Após dominar o básico:
1. Crie skills customizadas
2. Configure modelos específicos
3. Otimize prompts criativos
4. Integre com CRM
5. Automatize deployments
6. Monitore métricas

---

**Versão**: 1.0.0  
**Atualização**: 2024-01-08
