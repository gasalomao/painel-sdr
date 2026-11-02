---
name: frontend-design
description: Direção de design profissional para sites do Site Studio. Use quando criar, redesenhar ou refinar páginas e tokens visuais de um projeto de site.
---
# Design Profissional

Transforma o contexto confirmado do negócio em uma direção visual intencional: tokens, tipografia e composição editorial. Originalidade vem de hierarquia e conteúdo, não de efeitos.

## Quando usar
- Criar ou redesenhar qualquer página ou componente do site.
- Definir ou revisar tokens de cor, tipografia, espaçamento e borda.
- Avaliar se a identidade visual reflete o negócio real.

## Processo
1. Identifique público, tarefa principal e personalidade real. Escreva a intenção estética em uma frase (ex.: editorial acolhedor para atendimento humano).
2. Antes do layout, defina tokens CSS semânticos: fundo, superfície, texto, texto secundário, marca, borda, foco; escala tipográfica fluida, largura de leitura, espaçamentos, raios e sombras. Máximo duas famílias disponíveis; sem importar fontes remotas arbitrárias.
3. Desenhe a hierarquia do primeiro viewport: quem atende, o que oferece, onde, próximo passo. Alterne densidade conforme função: lista para serviços, narrativa para processo, imagem para evidência. Grid não obriga transformar tudo em cards.
4. Implemente com React e CSS existentes. Preserve conteúdo e fluxos; refine estados hover/foco/ativo/erro; adapte a conteúdo real (títulos longos, falta de foto).

## Checks
- 320, 375, 768 e 1440 px; leitura a 200%; contraste; foco visível.
- Compare screenshot real com a intenção declarada; sem screenshot, declare revisão estrutural.

## Anti-patterns
- Hero intercambiável, gradiente roxo automático, cartões repetidos.
- Sombras sem hierarquia, animação para esconder vazio, seções inventadas para preencher espaço.

## DoD
Tokens coerentes aplicados; CTA funcional; hierarquia reconhecível em mobile e desktop; fatos preservados; verificações executadas separadas das pendentes.
