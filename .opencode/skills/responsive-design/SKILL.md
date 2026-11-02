---
name: responsive-design
description: Adaptação responsiva de 320px ao desktop para sites do Site Studio. Use em toda mudança de layout, menu, galeria ou formulário.
---
# Responsivo

Mobile-first com CSS fluido e breakpoints motivados pelo conteúdo. Sem overflow, sem esconder ação essencial.

## Quando usar
- Qualquer alteração de layout, navegação, galeria, tabela ou formulário.
- Revisar um site em viewports estreitas.
- Decidir breakpoints e comportamento de menu.

## Processo
1. Comece pela menor largura com ordem de leitura semântica. Grid/Flex, minmax, max-width, clamp — nunca "escalar o desktop para baixo".
2. Breakpoints quando o conteúdo deixa de caber. Menu, galeria, preços e formulários continuam completos; ação principal nunca escondida para resolver overflow.
3. Imagens reservam proporção; logo usa contain; recorte intencional em fotos. Títulos/URLs longas quebram sem cobrir controles. Barras fixas respeitam safe areas e não escondem rodapé, foco ou erro.
4. Menus expansíveis: botão com nome, aria-expanded, fechamento por teclado, navegação funcional. Interações sem dependência de hover. Alvos ≥44px quando possível, nunca abaixo do mínimo acessível aplicável.

## Checks
- 320, 375, 768, 1440 px; retrato/paisagem; zoom 200%; rolagem horizontal inexistente.
- Percorrer CTA, formulário, galeria e menu com toque e teclado, inclusive conteúdo longo.

## Anti-patterns
- width fixa no body, fonte minúscula para caber, height:100vh bloqueando conteúdo.
- Carrossel obrigatório, overflow:hidden mascarando layout quebrado.

## DoD
Nenhuma perda de informação nem overflow não intencional; leitura, toque, foco e CTA funcionam em cada viewport testada; resoluções não verificadas reportadas.
