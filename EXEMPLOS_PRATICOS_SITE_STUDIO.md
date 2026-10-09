# 💼 Exemplos Práticos e Casos de Uso - Site Studio

> Exemplos reais de uso do Site Studio para diferentes cenários

---

## 📋 Índice

1. [Casos de Uso Comuns](#casos-de-uso-comuns)
2. [Exemplos de Prompts Efetivos](#exemplos-de-prompts-efetivos)
3. [Receitas de Código](#receitas-de-código)
4. [Troubleshooting por Cenário](#troubleshooting-por-cenário)
5. [Skills Customizadas](#skills-customizadas)
6. [Integrações](#integrações)

---

## 🎯 Casos de Uso Comuns

### 1. Clínica Odontológica

**Contexto:**
- Cliente: Dr. João Silva
- Segmento: Saúde - Odontologia
- Localização: São Paulo, SP
- Serviços: Implantes, Ortodontia, Clareamento

**Prompt Inicial:**
```
Crie um site profissional para a clínica odontológica com:

HOME:
- Hero com foto do consultório (asset fornecido)
- Apresentação do Dr. João Silva
- Destaques dos principais tratamentos
- Depoimentos de pacientes (inventar 3 genéricos)
- CTA: agendar consulta via WhatsApp

SERVIÇOS:
- Implantes dentários (descrição, benefícios, duração)
- Ortodontia (tipos de aparelhos, tempo de tratamento)
- Clareamento (técnicas, resultados esperados)

SOBRE:
- História da clínica
- Formação do Dr. João Silva
- Estrutura do consultório
- Tecnologias utilizadas

CONTATO:
- Formulário de contato
- Endereço com mapa
- Horário de funcionamento
- Telefones e WhatsApp

Estilo: Moderno, limpo, transmite profissionalismo e confiança.
Cores: Azul (confiança) + branco (limpeza)
```

**Assets Necessários:**
- Logo da clínica (PNG transparente)
- Foto do consultório (JPG alta qualidade)
- Foto do Dr. João Silva (opcional)

**Resultado Esperado:**
- Site responsivo com 4 seções
- Formulário funcional
- WhatsApp integrado
- Google Maps embed
- Tempo: ~5-8 minutos

---

### 2. Restaurante

**Contexto:**
- Cliente: Restaurante Sabor Italiano
- Segmento: Gastronomia - Italiana
- Localização: Rio de Janeiro, RJ
- Especialidade: Massas artesanais

**Prompt Inicial:**
```
Crie um site elegante para o restaurante italiano com:

HOME:
- Banner com foto dos pratos principais
- Slogan: "Tradição italiana no coração do Rio"
- Cardápio em destaque
- Horário e localização
- Botão de reserva via WhatsApp

CARDÁPIO:
Entradas:
- Bruschetta al Pomodoro - R$ 28
- Carpaccio di Manzo - R$ 45
- Burrata com Tomate - R$ 38

Massas (com descrição):
- Spaghetti alla Carbonara - R$ 62
- Fettuccine Alfredo - R$ 58
- Ravioli ai Funghi - R$ 68
- Lasagna Bolognese - R$ 72

Sobremesas:
- Tiramisù - R$ 32
- Panna Cotta - R$ 28
- Cannoli Siciliano - R$ 25

SOBRE:
- História (família italiana, receitas tradicionais)
- Chef: Giovanni Rossi (30 anos de experiência)
- Ambiente aconchegante

CONTATO:
- Endereço: Rua das Laranjeiras, 234 - Laranjeiras, RJ
- Telefone: (21) 3456-7890
- WhatsApp: (21) 98765-4321
- Horário: Ter-Dom 12h-15h / 19h-23h (fechado segunda)

Estilo: Elegante, acolhedor, cores quentes.
Paleta: Vermelho italiano + dourado + bege
Tipografia: Serif para títulos (elegância)
```

**Edições Posteriores:**
```
1. "Adicione uma seção de promoções: Almoço executivo R$ 45"
2. "Mude a cor do botão de reserva para vermelho (#C41E3A)"
3. "Adicione campo de observações no formulário de contato"
```

---

### 3. Escritório de Advocacia

**Contexto:**
- Cliente: Silva & Associados Advocacia
- Segmento: Jurídico - Direito Empresarial
- Localização: Brasília, DF
- Especialidades: Contratos, Societário, Tributário

**Prompt Inicial:**
```
Crie um site corporativo e sóbrio para o escritório de advocacia:

HOME:
- Hero: "Excelência em Direito Empresarial há 25 anos"
- Áreas de atuação em cards
- Números: 500+ clientes atendidos, 95% casos ganhos
- CTA: agendar consulta

ÁREAS DE ATUAÇÃO:
- Direito Societário (constituição, fusões, aquisições)
- Direito Contratual (elaboração e revisão de contratos)
- Direito Tributário (planejamento e contencioso)
- Compliance (programas de integridade)

EQUIPE:
- Dra. Maria Silva - Sócia fundadora (25 anos OAB)
- Dr. Carlos Santos - Sócio (18 anos OAB)
- 8 advogados associados

BLOG / ARTIGOS:
- Últimas mudanças na legislação
- Artigos sobre compliance
- Dicas empresariais

CONTATO:
- Formulário com: nome, empresa, assunto, mensagem
- Endereço: SCS Quadra 1, Bloco A, Sala 301 - Brasília, DF
- Telefone: (61) 3456-7890
- Email: contato@silvaassociados.adv.br

Estilo: Corporativo, sóbrio, transmite seriedade e confiança.
Cores: Azul marinho + cinza + dourado (detalhes)
Tipografia: Sans-serif moderna e legível
```

**Skills Recomendadas:**
- SEO Jurídico
- LGPD Compliance
- Acessibilidade WCAG AA

---

### 4. E-commerce Simples (Landing Page)

**Contexto:**
- Cliente: Loja Online de Cosméticos Naturais
- Segmento: E-commerce - Beleza
- Produto: Linha de sabonetes artesanais

**Prompt Inicial:**
```
Crie uma landing page para venda de sabonetes artesanais:

HERO:
- Título: "Beleza Natural para sua Pele"
- Subtítulo: "Sabonetes 100% naturais, veganos e sustentáveis"
- CTA: "Comprar agora" (link para WhatsApp)
- Imagem: produto em destaque

PRODUTOS:
Sabonete Lavanda:
- 100g, R$ 25,00
- Benefícios: relaxante, hidratante
- Ingredientes: óleo de lavanda, manteiga de karité

Sabonete Tea Tree:
- 100g, R$ 28,00
- Benefícios: antibacteriano, pele oleosa
- Ingredientes: óleo de melaleuca, argila verde

Sabonete Rosa Mosqueta:
- 100g, R$ 32,00
- Benefícios: anti-idade, cicatrizante
- Ingredientes: óleo de rosa mosqueta, vitamina E

DIFERENCIAIS:
- ✓ 100% natural
- ✓ Vegano
- ✓ Cruelty-free
- ✓ Embalagem sustentável
- ✓ Produção artesanal

COMO COMPRAR:
1. Escolha seu sabonete
2. Entre em contato via WhatsApp
3. Informe quantidade e endereço
4. Receba em até 3 dias úteis

Formas de pagamento: PIX, cartão (via link)
Frete grátis acima de R$ 100

SOBRE:
- História da marca
- Processo de fabricação artesanal
- Compromisso com sustentabilidade

CONTATO:
- WhatsApp: (11) 98765-4321
- Instagram: @cosmeticosnaturais
- Email: contato@cosmeticosnaturais.com

Estilo: Natural, acolhedor, sustentável.
Cores: Verde (natureza) + bege + branco
Elementos: Folhas, texturas naturais
```

---

### 5. Portfólio Fotográfico

**Contexto:**
- Cliente: Ana Costa - Fotógrafa
- Segmento: Serviços - Fotografia
- Especialidades: Casamentos, Ensaios, Corporativo

**Prompt Inicial:**
```
Crie um portfólio minimalista para fotógrafa:

HOME:
- Hero fullscreen com foto de destaque
- Texto: "Ana Costa | Fotografia autoral"
- Menu discreto: Portfólio / Sobre / Contato

PORTFÓLIO:
Categorias em grid:
- Casamentos (12 fotos em galeria)
- Ensaios (10 fotos)
- Eventos Corporativos (8 fotos)
- Retratos (15 fotos)

Cada foto abre em lightbox com:
- Imagem grande
- Descrição breve
- Data e local

SOBRE:
- Biografia de Ana Costa
- Formação e experiência
- Estilo fotográfico
- Equipamentos utilizados
- Prêmios e reconhecimentos

SERVIÇOS:
- Casamentos (8h cobertura) - sob consulta
- Ensaios (2h sessão) - sob consulta
- Corporativo (evento/produto) - sob consulta
- Inclui: fotos tratadas, galeria online

CONTATO:
- Email: ana@anacostafotografia.com
- WhatsApp: (11) 98765-4321
- Instagram: @anacostafoto
- Formulário: nome, tipo de ensaio, data, mensagem

Estilo: Minimalista, clean, foco nas fotos.
Cores: Preto + branco + 1 accent discreto
Layout: Grid assimétrico, muito espaço em branco
Tipografia: Serif elegante para nome, sans-serif para corpo
```

**Considerações Técnicas:**
- Imagens devem ser otimizadas (WebP)
- Lazy loading obrigatório
- Lightbox com navegação por teclado
- Galeria responsiva (Masonry layout)

---

## 💡 Exemplos de Prompts Efetivos

### Prompts para Criação

#### ✅ BOM: Específico e Estruturado
```
Crie um site para salão de beleza com:
- Home: apresentação, serviços em destaque, depoimentos
- Serviços: corte (R$80), coloração (R$200), manicure (R$50)
- Equipe: 3 profissionais com fotos e especialidades
- Contato: formulário, endereço, WhatsApp
Cores: Rosa suave + dourado
```

#### ❌ RUIM: Vago e Genérico
```
Faz um site bonito pra mim
```

#### ✅ BOM: Com Contexto Real
```
Site para pet shop "Amigo Fiel" em Curitiba:
- Serviços: banho (R$50), tosa (R$80), veterinário
- Produtos: ração, brinquedos, acessórios
- Cliente: donos de cães e gatos classe B/C
- CTA: agendar banho via WhatsApp (41) 99999-9999
```

#### ❌ RUIM: Sem Dados Concretos
```
Crie um site de pet shop com várias coisas
```

### Prompts para Edição

#### ✅ BOM: Cirúrgico e Claro
```
No arquivo src/tokens.css, na linha 15, 
troque "--color-primary: #000000" por "--color-primary: #3B82F6"
```

#### ❌ RUIM: Ambíguo
```
Muda a cor pra azul
```

#### ✅ BOM: Ação Específica
```
No cabeçalho, adicione um menu hamburguer para mobile que abre/fecha ao clicar
```

#### ❌ RUIM: Muito Vago
```
Melhora o menu
```

#### ✅ BOM: Com Localização Exata
```
Na seção "Sobre", terceiro parágrafo, corrija "fundada em 1990" para "fundada em 1995"
```

#### ❌ RUIM: Sem Contexto
```
Tem um erro de data
```

---

## 🧑‍💻 Receitas de Código

### Receita 1: Integração com WhatsApp

```typescript
// Em src/App.tsx
function WhatsAppButton({ phone, message }: { phone: string; message: string }) {
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  
  return (
    <a 
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-whatsapp"
    >
      <svg>/* ícone WhatsApp */</svg>
      Falar no WhatsApp
    </a>
  );
}

// Uso:
<WhatsAppButton 
  phone="5511999999999" 
  message="Olá! Gostaria de agendar uma consulta." 
/>
```

### Receita 2: Formulário de Contato

```typescript
// Em src/components/ContactForm.tsx
import { useState } from 'react';

export function ContactForm() {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    
    const form = e.currentTarget;
    const data = new FormData(form);
    
    try {
      // Endpoint fornecido pelo sistema
      const response = await fetch('/api/sites/forms/submit?project_id=xxx', {
        method: 'POST',
        body: data
      });
      
      if (response.ok) {
        setSuccess(true);
        form.reset();
      }
    } catch (error) {
      alert('Erro ao enviar. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }
  
  if (success) {
    return <div className="success">Mensagem enviada com sucesso!</div>;
  }
  
  return (
    <form onSubmit={handleSubmit}>
      <input type="text" name="name" placeholder="Nome" required />
      <input type="email" name="email" placeholder="E-mail" required />
      <input type="tel" name="phone" placeholder="Telefone" />
      <textarea name="message" placeholder="Mensagem" required />
      <button type="submit" disabled={loading}>
        {loading ? 'Enviando...' : 'Enviar'}
      </button>
    </form>
  );
}
```

### Receita 3: Galeria de Imagens com Lightbox

```typescript
// Em src/components/Gallery.tsx
import { useState } from 'react';

interface Image {
  src: string;
  alt: string;
  caption?: string;
}

export function Gallery({ images }: { images: Image[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  
  function next() {
    if (selected !== null && selected < images.length - 1) {
      setSelected(selected + 1);
    }
  }
  
  function prev() {
    if (selected !== null && selected > 0) {
      setSelected(selected - 1);
    }
  }
  
  function close() {
    setSelected(null);
  }
  
  return (
    <>
      <div className="gallery-grid">
        {images.map((img, i) => (
          <img
            key={i}
            src={img.src}
            alt={img.alt}
            onClick={() => setSelected(i)}
            className="gallery-thumb"
          />
        ))}
      </div>
      
      {selected !== null && (
        <div className="lightbox" onClick={close}>
          <button onClick={(e) => { e.stopPropagation(); close(); }}>×</button>
          <button onClick={(e) => { e.stopPropagation(); prev(); }}>‹</button>
          <img src={images[selected].src} alt={images[selected].alt} />
          <button onClick={(e) => { e.stopPropagation(); next(); }}>›</button>
          {images[selected].caption && <p>{images[selected].caption}</p>}
        </div>
      )}
    </>
  );
}
```

### Receita 4: Menu Mobile Responsivo

```typescript
// Em src/components/Header.tsx
import { useState } from 'react';

export function Header() {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <header>
      <div className="logo">Meu Site</div>
      
      <button 
        className="menu-toggle"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Menu"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      
      <nav className={isOpen ? 'open' : ''}>
        <a href="#home" onClick={() => setIsOpen(false)}>Home</a>
        <a href="#servicos" onClick={() => setIsOpen(false)}>Serviços</a>
        <a href="#sobre" onClick={() => setIsOpen(false)}>Sobre</a>
        <a href="#contato" onClick={() => setIsOpen(false)}>Contato</a>
      </nav>
    </header>
  );
}
```

```css
/* Em src/styles.css */
@media (max-width: 768px) {
  .menu-toggle {
    display: block;
  }
  
  nav {
    position: fixed;
    top: 0;
    right: -100%;
    width: 80%;
    height: 100vh;
    background: var(--color-surface);
    transition: right 0.3s;
    flex-direction: column;
    padding: 2rem;
  }
  
  nav.open {
    right: 0;
  }
}
```

### Receita 5: Scroll Suave entre Seções

```typescript
// Em src/App.tsx
import { useEffect } from 'react';

export function App() {
  useEffect(() => {
    // Intercepta cliques em links âncora
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }, []);
  
  return (
    <>
      <section id="home">{/* conteúdo */}</section>
      <section id="servicos">{/* conteúdo */}</section>
      <section id="sobre">{/* conteúdo */}</section>
      <section id="contato">{/* conteúdo */}</section>
    </>
  );
}
```

---

## 🐛 Troubleshooting por Cenário

### Cenário 1: Build Falha com Erro de Sintaxe

**Problema:**
```
Build failed: SyntaxError: Unexpected token '<' in JSON
```

**Diagnóstico:**
- Agent gerou JSX com comentários HTML (`<!-- -->`)
- Deve usar comentários JSX (`{/* */}`)

**Solução Automática:**
- Agent detecta e corrige automaticamente
- Ferramenta `patch` limpa comentários HTML

**Solução Manual:**
```
Prompt: "Substitua todos os comentários HTML por comentários JSX"
```

---

### Cenário 2: Imagens Não Carregam

**Problema:**
```
GET /assets/logo.png 404 Not Found
```

**Diagnóstico:**
- Caminho do asset incorreto
- Asset não foi feito upload
- Path público não foi gerado

**Solução:**
1. Verificar se asset existe:
```typescript
GET /api/sites/[id]/assets
```

2. Conferir `public_path` do asset

3. Corrigir path no código:
```
Prompt: "Use o caminho correto do logo: /assets/abc123/logo.png"
```

---

### Cenário 3: Formulário Não Envia

**Problema:**
```
POST /api/sites/forms/submit 400 Bad Request
```

**Diagnóstico:**
- `project_id` ausente ou inválido
- Endpoint incorreto
- CORS bloqueado

**Solução:**
1. Verificar se `formEndpoint` está no contexto:
```typescript
await tools.execute("get_context", {});
// Retorna: { cta: { ... }, formEndpoint: "https://..." }
```

2. Usar endpoint correto:
```typescript
<form action={formEndpoint} method="POST">
```

---

### Cenário 4: Deploy Falha no Cloudflare

**Problema:**
```
Cloudflare error: Invalid project name
```

**Diagnóstico:**
- Nome do projeto tem caracteres inválidos
- Token sem permissões
- Account ID incorreto

**Solução:**
1. Verificar configuração:
```env
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

2. Validar permissões do token:
- Cloudflare Pages: Edit

3. Re-tentar deploy manualmente:
```typescript
POST /api/sites/[id]/deploy
{ "revision_id": "..." }
```

---

### Cenário 5: Modo Patch Only Não Ativa

**Problema:**
Agent reescreve arquivo inteiro ao invés de fazer patch

**Diagnóstico:**
- Pedido não é considerado "simples"
- Site ainda não tem revisão base
- Há trabalho pendente

**Solução:**
1. Forçar edição cirúrgica:
```
Prompt: "Apenas troque a cor #000 por #3B82F6 no arquivo src/tokens.css, linha 15"
```

2. Usar termos específicos:
- "apenas", "somente", "troque", "mude", "corrija"
- Evitar: "crie", "refaça", "adicione seção"

---

## 🎨 Skills Customizadas

### Skill 1: Blog SEO-Friendly

```typescript
{
  "name": "Blog com SEO",
  "description": "Adiciona seção de blog com boas práticas de SEO",
  "category": "content",
  "tags": ["blog", "seo", "artigos", "conteúdo"],
  "trigger_mode": "automatic",
  "priority": 8,
  "instructions": `
    Quando solicitado blog ou artigos:
    
    1. ESTRUTURA:
       - Lista de artigos com thumbnail, título, resumo, data
       - Página individual por artigo
       - Navegação: anterior/próximo
       - Sidebar: artigos recentes, categorias
    
    2. SEO:
       - Meta tags: title, description, og:image
       - URLs amigáveis: /blog/slug-do-artigo
       - Heading hierarchy: h1 > h2 > h3
       - Alt text em todas as imagens
       - Schema.org BlogPosting
    
    3. CONTEÚDO:
       - Mínimo 3 artigos exemplo
       - Cada artigo: 300+ palavras
       - Formatação: negrito, itálico, listas
       - CTA ao final: contato ou newsletter
    
    4. COMPONENTES:
       - ArticleCard: thumb + título + resumo + data
       - ArticleContent: renderiza markdown
       - ShareButtons: WhatsApp, Facebook, Twitter
       - RelatedArticles: 3 artigos relacionados
  `
}
```

### Skill 2: Modo Escuro Automático

```typescript
{
  "name": "Dark Mode",
  "description": "Implementa tema escuro com toggle",
  "category": "design",
  "tags": ["dark", "theme", "modo escuro", "noturno"],
  "trigger_mode": "manual",
  "priority": 5,
  "instructions": `
    Implementar dark mode completo:
    
    1. TOKENS (src/tokens.css):
       :root {
         --color-bg: #ffffff;
         --color-text: #000000;
         --color-surface: #f5f5f5;
       }
       
       :root[data-theme="dark"] {
         --color-bg: #0a0a0a;
         --color-text: #ffffff;
         --color-surface: #1a1a1a;
       }
    
    2. TOGGLE (src/components/ThemeToggle.tsx):
       - Botão sol/lua
       - localStorage para persistência
       - useEffect para aplicar tema
       - Transição suave (200ms)
    
    3. IMAGENS:
       - Inverter brilho em dark mode se necessário
       - Logos: versão clara e escura
    
    4. CONTRASTE:
       - Garantir WCAG AA em ambos os temas
       - Testar todos os estados (hover, focus, active)
  `
}
```

### Skill 3: Performance Otimizada

```typescript
{
  "name": "Performance Premium",
  "description": "Otimizações de performance para LCP < 2.5s",
  "category": "performance",
  "tags": ["performance", "velocidade", "otimização", "lcp"],
  "trigger_mode": "always",
  "priority": 10,
  "instructions": `
    Aplicar otimizações de performance:
    
    1. IMAGENS:
       - Lazy loading: loading="lazy"
       - Sizes responsivos
       - Preload da hero image
       - WebP quando possível
    
    2. FONTS:
       - Preconnect ao Google Fonts
       - font-display: swap
       - Máximo 2 variantes
    
    3. CRITICAL CSS:
       - Inline CSS above-the-fold
       - Defer do restante
    
    4. JAVASCRIPT:
       - Defer scripts não críticos
       - Code splitting por rota
       - Debounce em event handlers
    
    5. MEDIDAS:
       - Evitar layout shifts (CLS)
       - Dimensions explícitas em imagens
       - Skeleton loaders
  `
}
```

---

## 🔗 Integrações

### Integração 1: Google Analytics

```typescript
// Adicionar no index.html antes do </head>
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>
```

**Prompt:**
```
Adicione Google Analytics com ID GA_MEASUREMENT_ID no head do index.html
```

---

### Integração 2: Facebook Pixel

```typescript
// Adicionar no index.html antes do </head>
<script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', 'PIXEL_ID');
  fbq('track', 'PageView');
</script>
```

**Prompt:**
```
Adicione Facebook Pixel com ID PIXEL_ID e rastreie conversões no formulário
```

---

### Integração 3: Google Maps

```typescript
// Em src/components/Map.tsx
export function Map({ address }: { address: string }) {
  const encoded = encodeURIComponent(address);
  const src = `https://www.google.com/maps/embed/v1/place?key=API_KEY&q=${encoded}`;
  
  return (
    <iframe
      src={src}
      width="100%"
      height="400"
      style={{ border: 0 }}
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
  );
}
```

**Prompt:**
```
Adicione Google Maps na seção de contato com o endereço: 
Rua das Flores, 123 - São Paulo, SP
```

---

### Integração 4: Calendly

```typescript
// Em src/components/BookingButton.tsx
export function BookingButton({ url }: { url: string }) {
  function openCalendly() {
    window.open(url, '_blank', 'width=800,height=800');
  }
  
  return (
    <button onClick={openCalendly} className="btn-booking">
      Agendar Consulta
    </button>
  );
}
```

**Prompt:**
```
Adicione botão de agendamento via Calendly: 
https://calendly.com/usuario/consulta
```

---

## 📊 Métricas e KPIs

### Métricas de Desenvolvimento

- **Tempo médio de criação**: 5-10 minutos
- **Taxa de sucesso (1ª tentativa)**: 85%
- **Taxa de sucesso (2ª tentativa)**: 95%
- **Economia vs manual**: 90% do tempo

### Métricas de Qualidade

- **LCP (Largest Contentful Paint)**: < 2.5s
- **CLS (Cumulative Layout Shift)**: < 0.1
- **FID (First Input Delay)**: < 100ms
- **Lighthouse Score**: > 90

### Métricas de Uso

- **Edições por projeto**: média 3-5
- **Revisões por projeto**: média 2-3
- **Deploys por projeto**: média 1-2
- **Tempo até publicação**: 1-3 dias

---

## 🎓 Lições Aprendidas

### ✅ Faça

1. **Seja específico**: Quanto mais detalhes, melhor o resultado
2. **Use assets reais**: Logo e fotos fazem diferença
3. **Valide dados**: Confira telefone, endereço, horários
4. **Teste antes de publicar**: Use preview extensivamente
5. **Documente mudanças**: Mensagens claras facilitam histórico
6. **Aproveite skills**: Ative as relevantes para seu projeto
7. **Itere gradualmente**: Faça uma mudança por vez

### ❌ Evite

1. **Prompts vagos**: "Faz bonito" não funciona
2. **Múltiplas ações**: "Mude X, Y e Z" confunde
3. **Inventar dados**: Use informações reais do cliente
4. **Ignorar erros**: Leia mensagens de erro com atenção
5. **Publicar sem testar**: Sempre use preview primeiro
6. **Pular validação**: Aguarde build completar
7. **Mudar tudo de uma vez**: Mudanças radicais têm mais risco

---

## 🚀 Próximos Passos

Após dominar os exemplos acima:

1. **Crie templates**: Salve estruturas que funcionam
2. **Desenvolva skills**: Customize para seu nicho
3. **Automatize workflows**: Integre com seu CRM
4. **Monitore performance**: Acompanhe métricas
5. **Colete feedback**: Aprenda com usuários
6. **Compartilhe conhecimento**: Documente suas descobertas

---

**Versão**: 1.0.0  
**Última Atualização**: 2024-01-08  
**Contribuidores**: Equipe Site Studio
