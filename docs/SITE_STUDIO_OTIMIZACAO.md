# Site Studio: velocidade, tokens e imagens — 05/10/2026

## Diagnóstico local e correções

- **Logo quebrada no preview:** `resolveWebsitePreviewAssets` existia, mas não era usada no fluxo de `SitePreview`. O preview agora carrega os assets autenticados do projeto, resolve seus caminhos antes de alimentar o Sandpack e renova URLs a cada 240 segundos, no foco da janela, troca de revisão e recarregamento. Os arquivos persistidos continuam com caminhos permanentes. Escopo client/projeto, status, finalidade e caminho do storage continuam validados.
- **Logo anexada antes do texto:** a finalidade automática ficava presa ao texto existente no momento do anexo. Uma imagem única passa a ser classificada pelo pedido final de uso de logo, respeitando finalidade escolhida explicitamente. Uma imagem única da galeria também pode ser promovida a logo pelo pedido explícito. Várias imagens não são classificadas indiscriminadamente como logos.
- **Uso omitido pelo agente:** pedido explícito para inserir uma única logo selecionada/ready verifica a presença do caminho permanente nas fontes antes do build. A ausência aciona as correções limitadas já existentes; não produz build aprovado. Esta checagem de referência não comprova posição, visibilidade ou qualidade visual: isso continua dependendo do QA renderizado.
- **Associação imagem/metadados:** cada imagem enviada ao modelo visual agora é precedida por ID, nome e finalidade, evitando ambiguidade entre vários anexos. A imagem original continua presente no contexto. Modelos textuais continuam usando a análise visual intermediária existente.
- **Patch aplicado duas vezes:** um bloco SEARCH/REPLACE era extraído como patch e também como escrita completa. Agora é extraído apenas como patch, preservando todo o restante do arquivo.
- **Contexto repetido:** leituras antigas com mais de 2.000 caracteres e escritas completas antigas são compactadas no payload enviado. As duas rodadas de ferramentas mais recentes, instruções, pedido, imagens, IDs e erros são preservados. Fontes podem ser relidas com `read/search`; o histórico original não é modificado.
- **Arquivos no prompt:** sites existentes recebem recortes menores (1.800 caracteres por CSS e 2.500 para App), com marcação explícita de truncamento e orientação para leitura adicional. Criação mantém os limites anteriores. Pedidos para recriar um site completo deixam de ser classificados como ajuste simples por conterem uma cor.
- **Upload parcialmente concluído:** cada upload confirmado sai da fila e permanece selecionado. Falha posterior não perde a seleção nem reenvia arquivos já confirmados na tentativa seguinte.

## Evidência e limites

O teste sintético com oito leituras de 20.000 caracteres verifica redução superior a 70% no tamanho serializado do contexto enviado na rodada seguinte. Isso mede bytes do payload simulado, não tokens faturados ou tempo real. Leituras adicionais podem compensar parte da economia: medir em produção antes de extrapolar percentuais.

Testes cobrem integração da resolução de assets no input real do Sandpack, renovação das URLs, isolamento de tenant, preservação integral do arquivo após patch, compactação sem mutação e pedidos de logo omitidos.

Não houve execução de geração paga, publicação ou migration remota. As capturas fornecidas mostram o sintoma; não contêm o arquivo original da logo. Esta alteração corrige o mecanismo do Studio, não modifica diretamente a revisão armazenada do site Casa do Agricultor. Reiniciar o worker dedicado é necessário para carregar o código novo do agente.

## Próximas medições recomendadas

1. Comparar dez pedidos representativos antes/depois: texto, cor, logo, imagem de produto, layout, criação; registrar duração total, rodadas, tokens de entrada/saída, leituras repetidas e aprovação visual. Usar o mesmo modelo e revisão base.
2. Avaliar contexto por trechos relevantes em vez de prefixos fixos; só adotar se diminuir releituras sem piorar resultado.
3. Avaliar cache de análise visual por hash do asset, modelo e versão do prompt. Preservar o original quando layout, detalhes ou tipografia exigirem inspeção direta; não substituir visão por descrições genéricas.
4. Medir custo de checkpoints/eventos/guardas no banco antes de agrupar operações. Preservar cancelamento, lease e fencing.
5. Adicionar ensaio de navegador com PNG transparente, JPEG e WEBP: colar antes de digitar, anexar depois do texto, escolher galeria, renovar URL e testar upload parcial. Conferir desktop/mobile e o artefato publicado em ambiente autorizado.

## Limitações ainda conhecidas

Apenas PNG/JPEG/WEBP são aceitos pelo upload atual. Não ampliar para SVG/GIF/AVIF sem validação completa da cadeia upload → visão → preview → publicação. A galeria tem cache próprio de URLs e o modelo recebe URLs temporárias; conversas muito longas ainda merecem teste específico de expiração. A detecção textual de intenção de logo é conservadora; com várias imagens, marcar a finalidade de cada uma. Fonte contendo o caminho não garante que a imagem esteja visível: QA visual real permanece necessário.


## Verificação final

- `npm test`: 81 arquivos passaram; 1.283 testes passaram; 31 testes externos skipped.
- Regressões focadas de agente, contexto, prompt, assets e modelos: 120 passaram.
- `npx tsc --noEmit --incremental false`: aprovado.
- ESLint global: 0 erros, 1.640 warnings; lint final dos novos módulos, preview e seleção de modelos: aprovado.
- `npm run build`: aprovado após integrar alterações simultâneas. Build anterior mostrou 24 warnings de tracing fora do módulo.
- `git diff --check`: aprovado.

Durante a sessão houve alterações externas em gateway, seleção de modelos, worker e aliases de imagem. Foram preservadas. Na seleção de modelos, corrigimos o filtro de visão para não recolocar um modelo apenas textual nos candidatos de QA. O fallback de descoberta manual foi limitado a IDs explicitamente prefixados `gateway:` e à allowlist, evitando inventar modelo OpenRouter desaparecido. Os testes que detectaram essas regressões voltaram a passar.
