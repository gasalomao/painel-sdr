# Impeccable — Resumo Executivo e Principais Conceitos

Extração completa dos 8 documentos-chave do Impeccable (upstream.json) realizada com sucesso.

## Arquivos Gerados

| Arquivo | Tamanho | Conteúdo |
|---------|---------|----------|
| `impeccable-SKILL.md` | 12.989 chars | Filosofia central e comandos |
| `impeccable-craft-floor.md` | 7.357 chars | Padrões mínimos obrigatórios |
| `impeccable-audit.md` | 7.859 chars | Sistema de auditoria 5D |
| `impeccable-critique.md` | 45.378 chars | Sistema completo de crítica (10 heurísticas Nielsen) |
| `impeccable-polish.md` | 6.617 chars | Processo de refinamento |
| `impeccable-new-work.md` | 61.162 chars | Criação de novos sites (workflow completo) |
| `impeccable-generate.md` | 12.998 chars | Geração de código |
| `impeccable-init.md` | 11.417 chars | Inicialização e setup |
| `impeccable-ANALYSIS.md` | — | Análise compilada dos princípios |
| `impeccable-INDEX.md` | — | Índice e próximos passos |

**Total**: 165.777 caracteres de documentação técnica

## Princípios Fundamentais Aplicáveis ao Site Studio

### 1. Filosofia "Go All Out"
- **Sem atalhos**: Trabalho completo, production-grade
- **Dream big and bold**: Trabalho distinto, excepcional, inspirador
- **Bounded verification**: Máximo 2 rodadas de QA (não loops infinitos)
- **Brief wins**: Especificação do usuário sempre vence

### 2. Craft Floor (Checklist Obrigatório)

Carregar antes de qualquer edit de UI:

#### Verificações Técnicas
- ✓ **Contraste**: ≥4.5:1 (body), ≥3:1 (large text)
- ✓ **Sombras**: offset + soft blur (não halos de zero-offset)
- ✓ **Espaçamento**: tight groups, generous separation, mais espaço acima de headings
- ✓ **Tipografia**: 65-75ch measure, tracking floor -0.04em, max 6rem display
- ✓ **Motion**: exponential ease-out, um momento autoral (não scattered effects)
- ✓ **Estados**: hover, disabled, loading, error, empty
- ✓ **Browser surfaces**: text selection, caret, scrollbars, focus rings tematizados
- ✓ **Copy**: controles nomeiam ação, erros nomeiam problema + recuperação

#### Recusas Automáticas (Anti-patterns)
- ❌ Cards idênticos como estrutura de página
- ❌ Gradient text (usar weight/size)
- ❌ Glass/blur decorativo
- ❌ Eyebrows em headings (BAN permanente)
- ❌ Monospace como costume "técnico"
- ❌ Unicode glyphs/emoji como sistema de ícones
- ❌ Border-left/right colorido >1px
- ❌ Hard offset shadows fora de neobrutalist
- ❌ System display faces (Impact, Arial Black)
- ❌ Máscaras geométricas imitando contornos orgânicos

### 3. Sistema de Auditoria (5 Dimensões, Score 0-4)

#### Dimensão 1: Acessibilidade (A11y)
- Contraste, ARIA, keyboard nav, HTML semântico, alt text, forms
- **Score**: 0=Inacessível → 4=WCAG AAA

#### Dimensão 2: Performance
- Layout thrashing, animações caras, lazy loading, bundle size
- **Score**: 0=Severo → 4=Otimizado

#### Dimensão 3: Theming
- Hard-coded colors, dark mode, tokens, theme switching
- **Score**: 0=Sem theming → 4=Sistema completo

#### Dimensão 4: Responsive
- Fixed widths, touch targets <44px, horizontal scroll, breakpoints
- **Score**: 0=Desktop-only → 4=Fluido

#### Dimensão 5: Implementation Integrity (CRÍTICO)
- Atalhos repetidos, drift do design system, estrutura intercambiável
- **Score**: 0=Drift sistêmico → 4=Coerente

**Total**: Score/20 com rating bands (18-20 Excellent, 14-17 Good, 10-13 Acceptable, 6-9 Poor, 0-5 Critical)

### 4. Sistema de Crítica (critique.md - 45K chars)

#### Design Health Score (10 Heurísticas Nielsen, 0-4 cada)
1. Visibility of System Status
2. Match System / Real World
3. User Control and Freedom
4. Consistency and Standards
5. Error Prevention
6. Recognition Rather Than Recall
7. Flexibility and Efficiency (n/a em Persuade/Experience)
8. Aesthetic and Minimalist Design
9. Error Recovery
10. Help and Documentation (n/a em Persuade/Experience)

**Total**: /40 (ou /32 se 2 n/a)

#### Cognitive Load Assessment
- **Intrinsic Load**: Complexidade inerente (gerenciar com progressive disclosure)
- **Extraneous Load**: Má design (eliminar completamente)
- **Germane Load**: Esforço de aprendizado (suportar com patterns consistentes)

#### Issue Severity (P0-P3)
- **P0**: Blocking (impede tarefa, fix imediatamente)
- **P1**: Major (WCAG violation, fix before release)
- **P2**: Minor (annoyance, workaround exists)
- **P3**: Polish (nice-to-fix, low impact)

#### Assessments Duais (Mandatory)
- **Assessment A**: Design review (LLM unanchored)
- **Assessment B**: Detector + browser evidence (deterministic)
- **Synthesis**: Weave findings, note agreements/disagreements

### 5. New Work Workflow (61K chars)

#### Decision Framework
1. **Decide what is already true**: Redesign vs established world vs no authority
2. **Ask what will change**: Modo (Persuade/Operate/Read/Experience), task, content
3. **Choose invention level**: Extend, new surface, or replace world

#### Concept Seed Process
- Run `impeccable concept-seed --scope direction --mode <mode>`
- Gera 7 visual systems do mundo cultural do audience
- Deals 3 random challengers (quebra ranking rut)
- User locks one direction
- **Comp-led vs Code-led**: build path preference

#### Direction Contract (6 blocos)
1. **THESIS**: A ideia central + recusa do default
2. **OWN-WORLD**: Palette e component language específicos
3. **STORY**: O que visitante entende, acredita, faz
4. **FIRST VIEWPORT**: Composição exata, escala, ação primária
5. **FORM**: Forma escolhida + posição na lista + seed key
6. **FINISH**: "unreviewed and undocumented is unfinished"

#### Comp-Led Build (State Machine)
0. **comps**: 3 compositional options → user approval
1. **spec**: Measure comp (grid, regions, fonts, palettes)
2. **plates**: Generate rasters at asset resolution (transparent PNGs)
3. **hero**: First viewport at measured layout (72% gate threshold)
4. **sections**: Rest of surface in spec's system
5. **motion**: Signature interaction orchestrated
6. **responsive**: Other viewports (desktop 1440, mobile 390)

**Gates**: Measure screen vs comp, refuse until pass or route taken

### 6. Modos de Visitante (Mode Rules)

#### Persuade (Landing, Marketing, Pricing)
- Design É o produto
- Ganhar atenção e ação
- Ship real imagery quando brief precisa
- Bolder color strategies permitidas

#### Operate (Dashboards, Apps, Admin, Settings)
- Visitante completa tarefa
- Scanabilidade, consistência, expectativas nativas
- Brand em detalhes precisos
- Restrained color comum

#### Read (Docs, Artigos, Guias)
- Visitante entende algo
- Estrutura para compreensão
- Reading experience worth staying

#### Experience (Portfolios, Galerias)
- Visitante dentro do trabalho
- Artefato lidera, interface recede

### 7. Calibration (Anti-defaults)

Evitar clusters saturados de AI:
- ❌ Warm cream + serif display + terracotta accent
- ❌ Near-black + neon accent + glowing edges
- ❌ Hairline editorial + italic serif + mono labels
- ❌ Flat saturated ink + hard shadows + condensed display

**Self-check**: Se alguém pode adivinhar estética pela categoria, rework.

### 8. Typography Rules

**Training-data defaults (EVITAR)**:
Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk, Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans

**Princípio**: Escolher faces como objetos do mundo do subject, não por associação (books→serif, tech→mono são associações a quebrar)

### 9. Color Strategy (Page Scale)

1. **Restrained**: Neutrals tinted + one accent (comum em Operate/Read)
2. **Committed**: One saturated color 30-60% da superfície
3. **Full palette**: 3-4 named roles
4. **Drenched**: Surface IS the color

**Princípio**: Color commits at page scale (fields owning regions), não accents scattered

### 10. Finish Review (Separate Agent)

- Spawn `impeccable-finish-reviewer` (sem fork de contexto)
- Input: request, screenshots, direction contract, QUALITY BAR, comp, spec, diffs
- Output: **disposition** (recapture | rebuild | ship | fix)
- **Bounded**: 2 rounds máximo unattended

## Integração no Site Studio

### Checklist Pré-Geração
- [ ] Carregar craft-floor antes de UI edits
- [ ] Verificar contraste ≥4.5:1
- [ ] Recusar anti-patterns automaticamente
- [ ] Validar estados (hover, disabled, loading, error, empty)
- [ ] Tematizar browser surfaces

### Sistema de Auditoria
- [ ] Implementar 5 dimensões com scoring 0-4
- [ ] Total/20 com rating bands
- [ ] P0-P3 severity tagging
- [ ] Detector automático + browser overlay

### Workflow de Criação
- [ ] Concept seed com 7 visual systems
- [ ] Direction contract (6 blocos obrigatórios)
- [ ] Comp-led vs code-led preference
- [ ] Build-phase state machine
- [ ] Bounded verification (2 passes max)

### Crítica Automatizada
- [ ] 10 heurísticas Nielsen
- [ ] Cognitive load assessment
- [ ] Dual assessments (A: design, B: detector)
- [ ] Persona-based testing

## Referências

- **Repository**: https://github.com/pbakaus/impeccable
- **Revision**: 87a6ab0c145adb85cbd428a99fa1377305e0818d
- **License**: Apache 2.0

## Próximos Passos

1. Ler `impeccable-critique.md` completo (45K chars) para entender:
   - Heuristics Scoring Guide detalhado
   - Personas reference completo
   - Browser overlay visualization
   - Persistence e trending

2. Ler `impeccable-new-work.md` completo (61K chars) para:
   - Comp-led build gates completos
   - Font-match measurement
   - Plate generation workflow
   - Region-map schema

3. Mapear outros documentos disponíveis (35 adicionais):
   - `animate.md`, `colorize.md`, `typeset.md`
   - `mode-*.md` (operate, persuade, read)
   - `visualize.md`, `component-review.md`

4. Criar adapters para Site Studio:
   - Craft-floor validator
   - Auditoria 5D scorer
   - Anti-pattern detector
   - Direction contract generator
