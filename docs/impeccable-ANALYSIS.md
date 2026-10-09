# Impeccable — Análise dos Princípios Fundamentais

Esta análise organiza os conceitos-chave extraídos dos documentos principais do Impeccable, focando em princípios aplicáveis ao Site Studio.

## 1. Filosofia Central (SKILL.md)

### Princípios Core
- **Go all out**: Sem atalhos, trabalho completo (exceto assets fornecidos pelo usuário)
- **Dream big and bold**: Trabalho distinto, bonito, excepcional e inspirador
- **Verify in bounded passes**: Screenshots, correções em batch, no máximo 2 rodadas de QA
- **Production-grade code**: Código pronto para produção, não protótipos

### Regras de Ouro
1. **A brief vence**: Honrar estética, materiais, fontes e paletas especificadas, mesmo conflitando com padrões
2. **Refinamento preserva; redesign substitui**: Refinamento mantém identidade; redesign substitui o visual mas preserva produto, conteúdo e função
3. **Símbolos carregados ficam fora da decoração**: Não usar emblemas ligados a militarismo, supremacia ou movimentos de ódio
4. **Autoridade visual é evidência**: Falta de DESIGN.md não torna projeto greenfield

### Modos de Visitante
- **Persuade** (landing pages, marketing): Design é o produto, ganhar atenção e ação
- **Operate** (dashboards, apps, admin): Scanabilidade, consistência, expectativas nativas
- **Read** (docs, artigos, guias): Estrutura para compreensão
- **Experience** (portfolios, galerias): Artefato lidera, interface recede

## 2. Padrões Mínimos (craft-floor.md)

### Checklist de Verificação
Estes são checks no resultado construído, não intenções:

#### Contraste
- Texto de corpo e placeholder ≥ 4.5:1
- Texto grande ≥ 3:1
- Em superfícies coloridas: matizar texto secundário dessa cor ou do foreground, nunca cinza

#### Profundidade
- Sombras carregam offset + soft blur
- Halo colorido de zero-offset é decoração

#### Espaçamento
- Grupos apertados, separação generosa
- Mais espaço acima de heading que abaixo
- Ler valores computados

#### Tipografia
- Body measure 65-75ch
- Display max 6rem
- Tracking floor -0.04em
- Headings balanceados
- Escala e peso óbvios
- Testar cópia real em todos breakpoints

#### Motion
- Um momento autoral, não efeitos espalhados
- Não entrada idêntica em cada seção
- Exponential ease-out de default já visível
- Ir além de transform/opacity: blur, backdrop-filter, clip-path, mask, shadow

#### Estados
- Hover, disabled, loading, error, empty
- Conteúdo real, controles funcionais, responsive, keyboard focus

#### Superfícies do Browser
- Text selection, caret, scrollbars customizadas, focus rings, underline offset, numerais tabulares
- Tematizar do palette (sinal mais barato de craft real)

#### Copy
- Linguagem do produto
- Controles nomeiam ação
- Erros nomeiam problema + recuperação

#### Cobertura
- Todo requisito da brief presente e encontrável em segundos

### Recusas (Defaults da Categoria)

#### Scaffolds de Página
- ❌ Cards de mesmo tamanho (icon + heading + text) como estrutura
- ❌ Template hero-metric (big number + label + stats)
- ❌ Kicker/eyebrow acima de heading (BAN permanente)
- ❌ Números de seção (01/02/03) sem informação sequencial
- ❌ Modal para tarefa sem necessidade de interrupção

#### Hábitos de Superfície
- ❌ Gradient text (usar weight ou size)
- ❌ Glass/blur como decoração
- ❌ Border-left/right colorido >1px em cards/listas
- ❌ Hard offset shadows fora de mundo neobrutalist
- ❌ Sparklines, progress rings como decoração
- ❌ Monospace como costume "técnico" (só para código/dados)
- ❌ System display face (Impact, Arial Black) como voz principal
- ❌ Unicode glyphs/emoji como sistema de ícones
- ❌ Máscaras geométricas imitando contornos orgânicos
- ❌ Light/dark por categoria (escolher pela cena de uso)

#### Codex (Regras Específicas)
- Tracking para em -0.04em (-0.02 a -0.03em melhor)
- Elevação uma vez: border OU shadow (não ghost card)
- Card radii 12-16px; pills para controles pequenos
- Ilustração real ou nenhuma (não sketch-style SVG)
- Backgrounds são superfícies (não stripes/grids decorativos)
- Claims vêm de verdade fornecida

#### Gemini
- Nunca animar imagem no hover (dar feedback ao container)

## 3. Sistema de Auditoria (audit.md)

### 5 Dimensões (Score 0-4 cada)

#### 1. Acessibilidade
- Contraste < 4.5:1 (ou 7:1 AAA)
- Motion sensitivity (prefers-reduced-motion)
- ARIA faltando
- Navegação por teclado
- HTML semântico
- Alt text
- Forms sem labels

**Score**: 0=Inacessível, 1=Gaps maiores, 2=Parcial, 3=Bom (WCAG AA), 4=Excelente (AAA)

#### 2. Performance
- Layout thrashing
- Animações caras (layout properties)
- Lazy loading faltando
- will-change overuse
- Bundle size
- Re-renders desnecessários

**Score**: 0=Severo, 1=Problemas maiores, 2=Parcial, 3=Bom, 4=Excelente

#### 3. Theming
- Cores hard-coded
- Dark mode quebrado
- Tokens inconsistentes
- Theme switching quebrado

**Score**: 0=Sem theming, 1=Mínimo, 2=Parcial, 3=Bom, 4=Excelente

#### 4. Responsive Design
- Fixed widths
- Touch targets < 44x44px
- Touch interaction quebrada
- Horizontal scroll
- Text scaling quebrado
- Breakpoints faltando

**Score**: 0=Desktop-only, 1=Issues maiores, 2=Parcial, 3=Bom, 4=Excelente

#### 5. Implementation Integrity (CRÍTICO)
- Atalhos repetidos
- Drift do design system
- Conteúdo decorativo enganoso
- Estrutura intercambiável

**Score**: 0=Drift sistêmico, 1=Falhas repetidas, 2=Vários issues, 3=Minor, 4=Coerente

### Report Structure
- **Audit Health Score**: Total/20 + Rating band
- **Implementation Integrity Verdict**: Pass/fail primeiro
- **Executive Summary**: Top 3-5 issues críticos
- **Detailed Findings**: P0-P3 severity
  - P0: Blocking (impede tarefa)
  - P1: Major (WCAG violation, fix before release)
  - P2: Minor (annoyance, workaround exists)
  - P3: Polish (nice-to-fix)
- **Patterns & Systemic Issues**: Problemas recorrentes
- **Positive Findings**: O que funciona bem

### Comandos Recomendados
Lista ordenada por prioridade (P0 → P1 → P2), terminar com `polish` como passo final.

## 4. Aplicação ao Site Studio

### Princípios Imediatos
1. **Bounded verification**: Limitar passes de QA a 2 rodadas máximo
2. **Craft floor obrigatório**: Carregar antes de qualquer edit de UI
3. **Brief wins**: Sistema de configuração visual deve permitir override total
4. **Production-grade**: Código gerado deve ser production-ready, não protótipo

### Checklist de Implementação
- [ ] Contraste automático ≥ 4.5:1
- [ ] Sombras com offset + blur
- [ ] Espaçamento consistente (tight groups, generous separation)
- [ ] Tipografia (measure 65-75ch, tracking -0.04em floor)
- [ ] Motion com exponential ease-out
- [ ] Estados completos (hover, disabled, loading, error, empty)
- [ ] Browser surfaces tematizadas
- [ ] Copy clara (ação + problema + recuperação)

### Sistema de Auditoria
Implementar as 5 dimensões com scoring 0-4:
1. Acessibilidade (contraste, ARIA, keyboard, semântica)
2. Performance (layout thrashing, lazy loading, bundle)
3. Theming (tokens, dark mode)
4. Responsive (touch targets 44x44px, breakpoints)
5. Implementation Integrity (drift, shortcuts)

### Recusas Automáticas
Sistema de detecção de anti-patterns:
- Cards idênticos como estrutura
- Gradient text
- Glass/blur decorativo
- Eyebrows em headings
- Monospace como costume
- Unicode glyphs como ícones
- Ghost cards (border + shadow)

## 5. Próximos Passos

1. **Ler documentos restantes**:
   - critique.md (45K chars - sistema completo de crítica UX)
   - new-work.md (61K chars - criação de novos sites)
   - polish.md, generate.md, init.md

2. **Mapear para Site Studio**:
   - Integrar craft-floor como checklist pré-geração
   - Implementar sistema de auditoria 5D
   - Criar detector de anti-patterns
   - Sistema de bounded verification (2 passes max)

3. **Criar guias de implementação**:
   - Adapter do craft-floor para geração de código
   - Sistema de scoring de qualidade
   - Templates seguindo princípios Impeccable
