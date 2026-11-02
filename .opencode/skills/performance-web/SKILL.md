---
name: performance-web
description: Performance web para sites do Site Studio sem sacrificar conteúdo. Use ao adicionar imagens, fontes, animações ou interações, e ao revisar custo de carregamento.
---
# Performance

Conteúdo inicial leve e estável; custo evitável removido. Métricas reais só existem quando medidas com ferramenta autorizada.

## Quando usar
- Adicionar/redimensionar imagens, fontes, vídeos ou animações.
- Criar interações de lista, formulário ou galeria.
- Reportar "velocidade" de um site.

## Processo
1. Identifique o provável LCP; torne o conteúdo inicial visível sem esperar animação. Nunca lazy loading no hero.
2. Assets dimensionados ao uso; aspect-ratio e dimensões reservadas (anti-CLS). Lazy somente abaixo da dobra; logo sem degradação ilegível.
3. CSS no lugar de JS para layout e transições. Reusar dependências permitidas; fontes disponíveis, poucos pesos. Sem vídeo autoplay, listeners contínuos ou imagem gigante em mobile.
4. Interação leve: atualizações localizadas, listas controladas, feedback de botão sem travar thread. Nunca alterar scripts/config fixa do sandbox para simular ganho.

## Checks
- Medir só com ferramenta autorizada. Metas orientativas: LCP ≤2,5s, INP ≤200ms, CLS ≤0,1 — não são resultados.
- Registrar dispositivo, rede, cenário. Sem medição → recomendações e riscos, não nota Lighthouse.

## Anti-patterns
- Preload de tudo, lazy no hero, fonte remota arbitrária, skeleton permanente, biblioteca pesada para um hover, memoização sem causa.

## DoD
Conteúdo inicial estável; mídia dimensionada; custo evitável removido; build real verificado quando disponível; métricas separadas de estimativas.
