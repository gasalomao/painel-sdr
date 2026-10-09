# Exemplos Práticos: Impeccable vs Genérico

**Propósito:** Mostrar lado a lado como código genérico difere de código Impeccable, com exemplos concretos extraídos da metodologia.

---

## 1. PALETA DE CORES

### ❌ Genérico (Cores Flat)

```css
/* Cores flat - sem profundidade */
:root {
  --color-primary: #6366F1; /* Roxo indigo genérico */
  --color-bg: #FFFFFF; /* Branco puro */
  --color-text: #000000; /* Preto puro */
  --color-gray: #6B7280; /* Gray neutro */
}

.hero {
  background: var(--color-primary);
  color: var(--color-bg);
}

.card {
  background: #F9FAFB; /* Outro gray flat */
  border: 1px solid #E5E7EB;
}
```

**Problemas:**
- Apenas 3 cores principais (sem escala)
- Grays neutros (não tintados)
- Branco/preto puros (#FFFFFF, #000000)
- Roxo genérico de template

### ✅ Impeccable (Paleta Escalonada)

```css
/* Paleta escalonada de 7 níveis tintados */
:root {
  /* Surfaces progressivas tintadas para o domínio (agricultura = verde terra) */
  --surface-1: oklch(8% 0.015 140); /* Quase preto com tint verde */
  --surface-2: oklch(12% 0.018 140);
  --surface-3: oklch(18% 0.02 140);
  --surface-4: oklch(25% 0.022 140); /* Mid-dark */
  --surface-5: oklch(35% 0.02 140);
  --surface-6: oklch(50% 0.015 140);
  --surface-7: oklch(92% 0.01 140); /* Quase branco com tint verde */
  
  /* Accent único vibrante */
  --accent: oklch(65% 0.19 140); /* Verde vivo agricultura */
  --accent-hover: oklch(68% 0.21 140);
  
  /* Texto sobre cada surface (derivados) */
  --text-on-surface-1: var(--surface-7);
  --text-on-surface-7: var(--surface-1);
  --text-secondary: oklch(60% 0.01 140); /* Tintado, não gray neutro */
}

/* Dark mode (inversão da escala) */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface-1: oklch(92% 0.01 140);
    --surface-7: oklch(8% 0.015 140);
  }
}

.hero {
  background: var(--surface-2); /* Não accent direto */
  color: var(--text-on-surface-1);
  border-bottom: 1px solid var(--surface-3); /* Sutil */
}

.card {
  background: var(--surface-3);
  border: 1px solid var(--surface-4); /* Contraste sutil */
}

.button-primary {
  background: var(--accent);
  color: var(--surface-1);
}

.button-primary:hover {
  background: var(--accent-hover);
}
```

**Qualidades:**
- 7 níveis progressivos de profundidade
- Todas as cores tintadas para o domínio (verde agricultura)
- Accent único e vibrante
- Dark mode nativo
- Sem branco/preto puros

---

## 2. TIPOGRAFIA

### ❌ Genérico (Tamanhos Fixos)

```css
:root {
  --font-sans: "Inter", sans-serif; /* Sem var() */
}

.title {
  font-size: 48px; /* Fixo, não responsivo */
  font-family: "Inter", sans-serif; /* Hardcoded */
  line-height: 1.2;
}

.subtitle {
  font-size: 24px;
  font-family: "Inter", sans-serif;
}

.body {
  font-size: 16px;
  font-family: "Inter", sans-serif;
  line-height: 1.5;
}

.caption {
  font-size: 14px;
}
```

**Problemas:**
- Tamanhos fixos em px (não escala)
- Font-family repetida (não DRY)
- Sem tracking/letter-spacing
- Sem line-height generoso em body
- Não usa clamp()

### ✅ Impeccable (Tipografia Fluida)

```css
:root {
  /* Famílias como tokens (NUNCA hardcoded) */
  --font-display: "Inter Display", system-ui, sans-serif;
  --font-body: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Courier New", monospace;
  
  /* Escala fluida completa com clamp() */
  --text-display: clamp(3rem, 1rem + 7vw, 8rem); /* 48px → 128px */
  --text-2xl: clamp(2rem, 1.5rem + 2.5vw, 3rem); /* 32px → 48px */
  --text-xl: clamp(1.5rem, 1.3rem + 1vw, 2rem); /* 24px → 32px */
  --text-lg: clamp(1.25rem, 1.1rem + 0.75vw, 1.5rem); /* 20px → 24px */
  --text-base: clamp(1rem, 0.92rem + 0.4vw, 1.125rem); /* 16px → 18px */
  --text-sm: clamp(0.875rem, 0.8rem + 0.375vw, 1rem); /* 14px → 16px */
  --text-xs: clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem); /* 12px → 14px */
  
  /* Tracking (letter-spacing) */
  --tracking-tight: -0.04em; /* Display grande */
  --tracking-normal: -0.01em; /* Headings */
  --tracking-wide: 0.02em; /* Labels, caps */
  
  /* Line-heights */
  --leading-tight: 1.1; /* Display */
  --leading-normal: 1.4; /* Headings */
  --leading-relaxed: 1.6; /* Body (generoso) */
  --leading-loose: 1.8; /* Copy longo */
}

.title {
  font-family: var(--font-display); /* Token, não hardcoded */
  font-size: var(--text-display); /* Fluido */
  letter-spacing: var(--tracking-tight); /* Negativo em grandes */
  line-height: var(--leading-tight);
  font-weight: 700;
}

.subtitle {
  font-family: var(--font-display);
  font-size: var(--text-xl);
  letter-spacing: var(--tracking-normal);
  line-height: var(--leading-normal);
  font-weight: 600;
}

.body {
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed); /* 1.6 generoso */
  letter-spacing: -0.005em; /* Sutil */
}

.caption {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-secondary); /* Tintado, não gray */
}

/* Body copy longo */
.article-content {
  font-size: var(--text-base);
  line-height: var(--leading-loose); /* 1.8 para leitura */
  max-width: 70ch; /* 65-75ch ideal */
}
```

**Qualidades:**
- Escala completa fluida (7 tamanhos)
- Famílias como var() (nunca hardcoded)
- Tracking negativo em display
- Line-height generoso em body (1.6+)
- Measure otimizada (70ch)

---

## 3. LAYOUT

### ❌ Genérico (Flexbox Everywhere)

```css
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
}

.features {
  display: flex;
  gap: 20px;
  padding: 60px 20px;
}

.feature-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 30px;
  background: #F9FAFB;
  border-radius: 8px;
}

.footer {
  display: flex;
  justify-content: space-between;
  padding: 40px 20px;
}
```

**Problemas:**
- Flexbox para tudo (não Grid)
- Espaçamento fixo (20px, 60px)
- Sem ritmo vertical consistente
- Border-radius fixo (8px sempre)

### ✅ Impeccable (Grid-First)

```css
:root {
  /* Espaçamento fluido */
  --space-xs: clamp(0.5rem, 0.4rem + 0.5vw, 0.75rem);
  --space-sm: clamp(0.75rem, 0.6rem + 0.75vw, 1rem);
  --space-md: clamp(1rem, 0.8rem + 1vw, 1.5rem);
  --space-lg: clamp(1.5rem, 1rem + 2vw, 2.5rem);
  --space-xl: clamp(2rem, 1.5rem + 2.5vw, 4rem);
  --space-2xl: clamp(3rem, 2rem + 5vw, 6rem);
  --space-section: clamp(4rem, 3rem + 5vw, 10rem); /* Entre seções */
  
  /* Geometria arredondada */
  --radius-sm: 0.5rem;
  --radius-md: 1rem;
  --radius-lg: 2rem;
  --radius-pill: 999px;
  --radius-circle: 50%;
}

/* Grid para estrutura da página */
.page-grid {
  display: grid;
  grid-template-columns: 
    [full-start] minmax(1rem, 1fr)
    [content-start] minmax(0, 1200px) [content-end]
    minmax(1rem, 1fr) [full-end];
  gap: var(--space-section); /* Ritmo vertical consistente */
}

.hero {
  grid-column: full; /* Full-width */
  display: grid;
  place-items: center;
  padding-block: var(--space-2xl);
  background: var(--surface-2);
}

.hero-content {
  grid-column: content;
  display: grid;
  gap: var(--space-lg); /* Ritmo interno */
  text-align: center;
}

/* Grid assimétrico para features (não cards idênticos) */
.features {
  grid-column: content;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-lg);
  padding-block: var(--space-section);
}

.feature-card {
  /* Flexbox DENTRO do componente */
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  background: var(--surface-3);
  border-radius: var(--radius-lg); /* Token, não hardcoded */
  border: 1px solid var(--surface-4);
}

/* Variação: card destaque maior */
.feature-card.featured {
  grid-column: span 2; /* Assimétrico */
  background: var(--accent);
  color: var(--surface-1);
}

.footer {
  grid-column: full;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-xl);
  padding: var(--space-xl) var(--space-md);
  background: var(--surface-2);
  border-top: 1px solid var(--surface-3);
}
```

**Qualidades:**
- CSS Grid para estrutura
- Flexbox apenas dentro de componentes
- Espaçamento fluido (clamp)
- Ritmo vertical consistente (--space-section)
- Layout assimétrico (featured span 2)
- Geometria em tokens

---

## 4. COMPONENTES

### ❌ Genérico (Sem Tokens)

```css
.button {
  padding: 12px 24px;
  background: #6366F1;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
}

.button:hover {
  background: #4F46E5;
}

.card {
  padding: 24px;
  background: white;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.badge {
  padding: 4px 12px;
  background: #EEF2FF;
  color: #6366F1;
  border-radius: 16px;
  font-size: 14px;
}
```

**Problemas:**
- Valores hardcoded (12px, 24px, 16px)
- Cores diretas (#6366F1, white)
- Border-radius inconsistente (8px, 12px, 16px)
- Sem sistema de sombras
- Sem estados completos

### ✅ Impeccable (Sistema de Tokens)

```css
:root {
  /* Já definidos: surfaces, accent, spacing, radius, shadows */
  
  /* Sombras em 3 níveis */
  --shadow-1: 0 1px 2px oklch(0% 0 0 / 0.1);
  --shadow-2: 0 4px 6px oklch(0% 0 0 / 0.1);
  --shadow-3: 0 10px 15px oklch(0% 0 0 / 0.15);
  
  /* Transições */
  --transition-fast: 150ms ease-out;
  --transition-base: 300ms ease-out;
  --transition-slow: 500ms ease-out;
}

/* Botão com todos os estados */
.button {
  /* Espaçamento de tokens */
  padding: var(--space-sm) var(--space-lg);
  
  /* Cores de tokens */
  background: var(--accent);
  color: var(--surface-1);
  
  /* Geometria de tokens */
  border: none;
  border-radius: var(--radius-pill); /* 999px */
  
  /* Tipografia de tokens */
  font-family: var(--font-body);
  font-size: var(--text-base);
  font-weight: 600;
  
  /* Sombra de tokens */
  box-shadow: var(--shadow-2);
  
  /* Transição suave */
  transition: all var(--transition-base);
  
  cursor: pointer;
}

.button:hover {
  background: var(--accent-hover);
  box-shadow: var(--shadow-3); /* Eleva */
  transform: translateY(-1px); /* Sutil */
}

.button:active {
  transform: translateY(0);
  box-shadow: var(--shadow-1);
}

.button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.button:disabled {
  background: var(--surface-4);
  color: var(--surface-6);
  cursor: not-allowed;
  box-shadow: none;
  opacity: 0.6;
}

/* Variante secundária */
.button.secondary {
  background: var(--surface-3);
  color: var(--text-on-surface-7);
  border: 1px solid var(--surface-4);
}

.button.secondary:hover {
  background: var(--surface-4);
}

/* Card */
.card {
  padding: var(--space-xl);
  background: var(--surface-3);
  border: 1px solid var(--surface-4);
  border-radius: var(--radius-lg); /* Consistente */
  box-shadow: var(--shadow-1);
  transition: all var(--transition-base);
}

.card:hover {
  box-shadow: var(--shadow-2);
  border-color: var(--surface-5);
}

/* Badge */
.badge {
  padding: var(--space-xs) var(--space-sm);
  background: var(--surface-4);
  color: var(--accent);
  border-radius: var(--radius-pill); /* Consistente */
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide); /* 0.02em */
}
```

**Qualidades:**
- TODOS os valores via var()
- Estados completos (hover, active, focus, disabled)
- Geometria consistente (pills, cards)
- Sombras em sistema de 3 níveis
- Transições suaves (300ms ease-out)
- Variantes mantêm tokens

---

## 5. SUPERFÍCIES DO NAVEGADOR

### ❌ Genérico (Browser Defaults)

```css
/* NADA - deixa defaults do navegador */

/* Resultado:
   - ::selection azul padrão do Chrome
   - :focus outline azul fino
   - caret preto padrão
   - scrollbar padrão
*/
```

**Problema:** Superfícies não temadas gritam "template não customizado"

### ✅ Impeccable (Customização Completa)

```css
:root {
  --selection-bg: var(--accent);
  --selection-text: var(--surface-1);
  --focus-ring: var(--accent);
  --caret-color: var(--accent);
  --scrollbar-thumb: var(--surface-5);
  --scrollbar-track: var(--surface-2);
}

/* Text selection */
::selection {
  background: var(--selection-bg);
  color: var(--selection-text);
}

::-moz-selection {
  background: var(--selection-bg);
  color: var(--selection-text);
}

/* Focus ring (acessibilidade) */
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* Remover outline padrão quando :focus-visible funciona */
:focus:not(:focus-visible) {
  outline: none;
}

/* Caret (cursor de texto) */
input,
textarea {
  caret-color: var(--caret-color);
}

/* Scrollbar customizada (Webkit) */
::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: var(--radius-pill);
  border: 3px solid var(--scrollbar-track);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--surface-6);
}

/* Scrollbar customizada (Firefox) */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

/* Placeholder text */
::placeholder {
  color: var(--text-secondary);
  opacity: 0.7;
}

/* Underline offset (links) */
a {
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
  text-decoration-color: var(--accent);
}

/* Numerais tabulares (dados) */
.data-table,
.price,
.metric {
  font-variant-numeric: tabular-nums;
}
```

**Qualidades:**
- Selection customizada com paleta
- Focus ring acessível e temado
- Caret colorido
- Scrollbar customizada (ambos browsers)
- Placeholder temado
- Underline offset refinado
- Numerais tabulares em dados

---

## 6. MOTION (ANIMAÇÃO)

### ❌ Genérico (Fade-in Everywhere)

```css
/* Mesma animação em tudo */
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.section {
  animation: fadeIn 0.5s ease-in; /* Ease-IN errado */
}

.card {
  animation: fadeIn 0.3s ease-in;
}

.button:hover {
  transition: all 0.2s ease-in-out; /* Ease-in-OUT genérico */
}
```

**Problemas:**
- Fade-in repetido em tudo
- Ease-in (lento no início, errado)
- Apenas opacity/transform (limitado)
- Não respeita prefers-reduced-motion

### ✅ Impeccable (Um Momento Autoral)

```css
:root {
  --transition-fast: 150ms cubic-bezier(0.16, 1, 0.3, 1); /* Expo out */
  --transition-base: 300ms cubic-bezier(0.16, 1, 0.3, 1);
  --transition-slow: 500ms cubic-bezier(0.16, 1, 0.3, 1);
}

/* UM momento autoral: hero reveal com múltiplos materiais */
@keyframes heroReveal {
  from {
    opacity: 0;
    transform: translateY(2rem);
    filter: blur(10px); /* Além de transform */
    clip-path: inset(0 0 100% 0);
  }
  to {
    opacity: 1;
    transform: translateY(0);
    filter: blur(0);
    clip-path: inset(0 0 0 0);
  }
}

.hero-title {
  animation: heroReveal var(--transition-slow) cubic-bezier(0.16, 1, 0.3, 1);
  animation-delay: 100ms;
}

/* Não repetir em outras seções */
.section {
  /* SEM animação de entrada - já está visível */
}

/* Hover states com material palette */
.card {
  transition: 
    transform var(--transition-base),
    box-shadow var(--transition-base),
    backdrop-filter var(--transition-base);
  backdrop-filter: blur(0);
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-3);
  backdrop-filter: blur(5px); /* Material além de transform */
}

/* Button com squeeze */
.button {
  transition: all var(--transition-fast);
}

.button:active {
  transform: scale(0.97); /* Squeeze sutil */
}

/* Respeitar preferência do usuário (OBRIGATÓRIO) */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Qualidades:**
- UM momento autoral memorável (hero)
- Ease-out exponencial (cubic-bezier)
- Materiais além de transform: blur, backdrop-filter, clip-path
- Não repetir em outras seções
- prefers-reduced-motion respeitado

---

## 7. ANTI-PATTERNS PROIBIDOS

### ❌ Cards Idênticos

```tsx
// NUNCA fazer isso
export default function Features() {
  const features = [
    { icon: "🌱", title: "Sustentável", text: "..." },
    { icon: "🚜", title: "Tecnologia", text: "..." },
    { icon: "🌾", title: "Qualidade", text: "..." },
  ];
  
  return (
    <div className="grid grid-cols-3 gap-4">
      {features.map(f => (
        <div className="card">
          <div className="icon">{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.text}</p>
        </div>
      ))}
    </div>
  );
}
```

### ✅ Layout Assimétrico

```tsx
// Fazer isso: tamanhos variados, destaque
export default function Features() {
  return (
    <div className="features-grid">
      {/* Primeiro destaque: span 2 */}
      <div className="feature-card featured">
        <h2>Agricultura Familiar Sustentável</h2>
        <p>Do campo direto para sua mesa, sem intermediários.</p>
        <img src="/assets/hero.jpg" alt="Campo" />
      </div>
      
      {/* Dois menores lado a lado */}
      <div className="feature-card">
        <span className="badge">Certificado</span>
        <h3>100% Orgânico</h3>
        <p>Sem agrotóxicos, com certificação.</p>
      </div>
      
      <div className="feature-card">
        <span className="badge">Local</span>
        <h3>Produtores da Região</h3>
        <p>Conhecemos cada agricultor parceiro.</p>
      </div>
      
      {/* Terceiro diferente: vertical */}
      <div className="feature-card vertical">
        <ul>
          <li>✓ Entrega em 24h</li>
          <li>✓ Preço justo</li>
          <li>✓ Rastreabilidade completa</li>
        </ul>
      </div>
    </div>
  );
}
```

```css
.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-lg);
}

.feature-card.featured {
  grid-column: span 2; /* Assimétrico */
  grid-row: span 2;
  display: grid;
  place-items: center;
  text-align: center;
}

.feature-card.vertical {
  grid-row: span 2;
}
```

### ❌ Eyebrows/Kickers

```tsx
// NUNCA fazer isso
<section>
  <span className="eyebrow">NOSSOS SERVIÇOS</span>
  <h2>O que oferecemos</h2>
</section>

<section>
  <span className="eyebrow">SOBRE NÓS</span>
  <h2>Nossa história</h2>
</section>
```

### ✅ Headings Autossuficientes

```tsx
// Fazer isso: heading se sustenta sozinho
<section>
  <h2>Do campo para sua mesa</h2>
  <p>Produtos orgânicos direto dos produtores familiares da região.</p>
</section>

<section>
  <h2>Três gerações cultivando a terra</h2>
  <p>Nossa história começou em 1950...</p>
</section>
```

### ❌ Gradient Text

```css
/* NUNCA fazer isso */
.title {
  background: linear-gradient(90deg, #6366F1, #EC4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

### ✅ Weight e Size para Ênfase

```css
/* Fazer isso */
.title {
  font-size: var(--text-display);
  font-weight: 700; /* Bold para ênfase */
  color: var(--accent); /* Ou cor de destaque */
}

.title strong {
  font-weight: 900; /* Extra bold para parte enfatizada */
  color: var(--accent);
}
```

---

## 8. FORMULÁRIO COMPLETO

### ❌ Genérico

```tsx
export default function ContactForm() {
  return (
    <form>
      <input type="text" placeholder="Nome" />
      <input type="email" placeholder="Email" />
      <textarea placeholder="Mensagem"></textarea>
      <button type="submit">Enviar</button>
    </form>
  );
}
```

**Problemas:**
- Sem labels (inacessível)
- Sem estados (loading, error, success)
- Sem validação
- Sem foco customizado

### ✅ Impeccable

```tsx
import { useState } from "react";

export default function ContactForm() {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("loading");
    setErrors({});
    
    const form = e.currentTarget;
    const data = new FormData(form);
    
    // Validação
    const name = data.get("name") as string;
    const email = data.get("email") as string;
    
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Nome é obrigatório";
    if (!email.includes("@")) newErrors.email = "Email inválido";
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setState("error");
      return;
    }
    
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        body: data,
      });
      
      if (!res.ok) throw new Error();
      
      setState("success");
      form.reset();
    } catch {
      setState("error");
      setErrors({ submit: "Erro ao enviar. Tente novamente." });
    }
  }
  
  return (
    <form onSubmit={handleSubmit} className="contact-form">
      {/* Campo com label associado */}
      <div className="field">
        <label htmlFor="name" className="label">
          Nome completo
        </label>
        <input
          type="text"
          id="name"
          name="name"
          className={`input ${errors.name ? "error" : ""}`}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "name-error" : undefined}
          disabled={state === "loading"}
        />
        {errors.name && (
          <span id="name-error" className="error-message" role="alert">
            {errors.name}
          </span>
        )}
      </div>
      
      <div className="field">
        <label htmlFor="email" className="label">
          Email
        </label>
        <input
          type="email"
          id="email"
          name="email"
          className={`input ${errors.email ? "error" : ""}`}
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? "email-error" : undefined}
          disabled={state === "loading"}
        />
        {errors.email && (
          <span id="email-error" className="error-message" role="alert">
            {errors.email}
          </span>
        )}
      </div>
      
      <div className="field">
        <label htmlFor="message" className="label">
          Mensagem
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          className="textarea"
          disabled={state === "loading"}
        />
      </div>
      
      {/* Botão com estados */}
      <button
        type="submit"
        className="button primary"
        disabled={state === "loading"}
        aria-busy={state === "loading"}
      >
        {state === "loading" ? "Enviando..." : "Enviar mensagem"}
      </button>
      
      {/* Feedback de sucesso */}
      {state === "success" && (
        <div className="alert success" role="status">
          ✓ Mensagem enviada! Responderemos em breve.
        </div>
      )}
      
      {/* Feedback de erro */}
      {errors.submit && (
        <div className="alert error" role="alert">
          ✕ {errors.submit}
        </div>
      )}
    </form>
  );
}
```

```css
.contact-form {
  display: grid;
  gap: var(--space-lg);
  max-width: 600px;
}

.field {
  display: grid;
  gap: var(--space-xs);
}

.label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-on-surface-7);
}

.input,
.textarea {
  padding: var(--space-sm) var(--space-md);
  font-family: var(--font-body);
  font-size: var(--text-base);
  background: var(--surface-3);
  border: 2px solid var(--surface-4);
  border-radius: var(--radius-md);
  color: var(--text-on-surface-7);
  transition: all var(--transition-base);
  caret-color: var(--accent); /* Customizado */
}

.input:focus,
.textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px oklch(from var(--accent) l c h / 0.1);
}

.input.error,
.textarea.error {
  border-color: var(--error);
}

.input:disabled,
.textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-message {
  font-size: var(--text-sm);
  color: var(--error);
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.alert {
  padding: var(--space-md);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: 500;
}

.alert.success {
  background: oklch(from var(--accent) l c h / 0.1);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.alert.error {
  background: oklch(from var(--error) l c h / 0.1);
  color: var(--error);
  border: 1px solid var(--error);
}
```

**Qualidades:**
- Labels associados corretamente
- Estados completos (idle, loading, success, error)
- Validação com feedback específico
- ARIA attributes (invalid, describedby, busy, alert, status)
- Disabled durante loading
- Caret customizado
- Focus ring acessível
- Touch targets adequados

---

## CHECKLIST FINAL DE IMPLEMENTAÇÃO

Ao implementar um site Impeccable, verificar:

### Estrutura
- [ ] Design direction registrado ANTES de código
- [ ] src/tokens.css criado ANTES de src/styles.css
- [ ] src/App.tsx usa tokens via var()

### Paleta
- [ ] 7 níveis de surface progressivos
- [ ] Todas as cores tintadas (não grays neutros)
- [ ] Um accent vibrante único
- [ ] Dark mode declarado
- [ ] Sem #FFFFFF, #000000, #6366F1 hardcoded

### Tipografia
- [ ] Escala completa com clamp() (7 tamanhos)
- [ ] Famílias como var(--font-*)
- [ ] Tracking negativo em display (-0.04em)
- [ ] Line-height generoso em body (1.6+)
- [ ] Measure 65-75ch em copy longo

### Layout
- [ ] CSS Grid para estrutura principal
- [ ] Flexbox apenas dentro de componentes
- [ ] Espaçamento fluido (--space-*)
- [ ] Ritmo vertical consistente
- [ ] Layout assimétrico (não grid uniforme)

### Componentes
- [ ] Geometria arredondada em tokens
- [ ] Sombras em sistema de 3 níveis
- [ ] Transições suaves (300ms ease-out)
- [ ] Estados completos (hover, active, focus, disabled)

### Browser Surfaces
- [ ] ::selection customizado
- [ ] :focus-visible customizado
- [ ] caret-color definido
- [ ] scrollbar temada
- [ ] placeholder temado

### Acessibilidade
- [ ] Contraste ≥4.5:1 (corpo) e ≥3:1 (display)
- [ ] Labels associados em formulários
- [ ] ARIA attributes apropriados
- [ ] Touch targets ≥44px
- [ ] Navegação por teclado funcional

### Motion
- [ ] UM momento autoral memorável
- [ ] Ease-out exponencial
- [ ] Materiais além de transform (blur, backdrop-filter)
- [ ] prefers-reduced-motion respeitado

### Anti-Patterns Evitados
- [ ] Sem cards idênticos em grid
- [ ] Sem eyebrows/kickers
- [ ] Sem gradient text
- [ ] Sem glass/blur decorativo
- [ ] Sem fade-in uniforme em seções

---

**Resultado:** Sites específicos, intencionais e tecnicamente impecáveis que transcendem templates genéricos.
