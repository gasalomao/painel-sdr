---
name: visual-critic
description: Crítica visual de sites do Site Studio separando observação, hipótese e verificação. Use ao revisar um resultado de render/screenshot ou declarar limites de uma revisão apenas estrutural.
---
# Crítica Visual

Avaliação por hierarquia, legibilidade, alinhamento, espaçamento, contraste, identidade e clareza da ação principal — com fronteira explícita entre o observado e o suposto.

## Quando usar
- Revisar screenshot/render real de um site.
- Declarar explicitamente que a revisão é apenas estrutural (sem screenshot).
- Priorizar correções por impacto.

## Processo
1. Declare a base da avaliação antes de opinar: screenshot real (e de quais viewports) ou somente código.
2. Liste problemas observados com evidência (região, elemento, condição) separados de hipóteses que exigem verificação.
3. Avalie hierarquia do primeiro viewport, legibilidade (tamanho/contraste/ruído), alinhamento e ritmo de espaçamento, consistência de identidade e proeminência do CTA.
4. Priorize correções concretas por impacto no objetivo do site (encontrar serviço, confiar, agir). Sem estimular rework cosmético sem causa.

## Checks
- Cada problema citado tem local e condição reproduzíveis.
- Revisão estrutural nunca usa linguagem de aprovação visual ("está bonito, aprovado").
- Aprovação visual exige screenshot real; aprovação de build exige resultado de ferramenta.

## Anti-patterns
- Alegar aprovação baseada somente em código.
- Confundir gosto pessoal com problema de design (sempre amarrar a legibilidade/objetivo).
- Ignorar mobile porque o screenshot foi desktop.

## DoD
Parecer com três seções: observado (com evidência), hipótese (a verificar) e pendências; correções priorizadas por impacto; base da avaliação declarada.
