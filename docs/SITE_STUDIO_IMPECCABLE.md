# Impeccable no Site Studio — 05/10/2026

## Fonte e intenção

Repositório: https://github.com/pbakaus/impeccable

Revisão fixada: `87a6ab0c145adb85cbd428a99fa1377305e0818d`. A biblioteca inclui o SKILL.src.md e todos os guias de skill/reference, sem cortes, com SHA-256 de cada documento. Licença Apache-2.0 e NOTICE preservados em src/lib/sites/impeccable. Não depende de rede durante a geração; atualizações do upstream precisam de revisão deliberada.

Esta é uma integração dos fundamentos e guias completos ao executor virtual do Site Studio, não uma instalação do CLI Impeccable. As adaptações operacionais ficam explícitas no prompt. Não se anuncia execução dos 61 detectores oficiais, concept-seed, subagentes, comp generation, font-match ou navegador interativo: essas capacidades não existem nas ferramentas deste runtime. Build/QA visual continuam no E2B configurado. Não se cria uma nova rota de serviços pagos.

## Problema corrigido

A integração anterior anunciava a skill mesmo desligada, escondia outras skills ao desligá-la e substituía o método original por uma receita: paletas por profissão, header de vidro, hero, duas colunas, FAQ e WhatsApp em quase todo site. A lista de proibições contradizia essa própria receita. Em edição, descartava o conteúdo da skill. Um starter grande podia ser considerado site existente.

Agora o toggle controla prompt, ferramentas, eventos e crítica visual. Skills privadas continuam respeitando escopo e ativação. Overrides antigos criados ao alternar o botão são reconhecidos pelo texto da receita legada e recebem a base atual; instruções customizadas de fato e o estado ligado/desligado são preservados.

## Criação: fundamentos completos antes de código

O prompt inclui integralmente: skill, craft-floor, init, new-work, os modos Persuade/Experience, Operate e Read, e os guias typeset, layout, colorize, animate, adapt, harden, clarify e optimize. Não corta esses documentos para acomodar código. O restante da biblioteca fica disponível por read_design_reference com paginação e catálogo de tamanhos, incluindo critique, audit, polish, distill, bolder, quieter, delight, overdrive, onboard e shape.

As variáveis confirmadas do cliente, CTA, instruções do projeto, prompt criativo e pedido atual aparecem explicitamente. Logo e anexos chegam pelo fluxo multimodal já existente. Fatos ausentes permanecem desconhecidos. Não há paleta fixa por segmento, hero obrigatório, FAQ obrigatório, componentes descartados automaticamente ou proibição arbitrária de uma cor solicitada.

O agente registra via record_design_direction: modo do visitante, tese, mundo visual, narrativa, primeiro viewport, interação marcante, tipografia, paleta, layout, imagem, movimento, responsividade, acessibilidade, copy e restrições. Criação e redesign ficam impedidos de alterar fontes antes desse registro. Redesign exige novo contrato; não reutiliza silenciosamente o anterior.

O contrato fica somente em website_builds.qa.design_direction, ligado à revisão gerada pelo RPC de conclusão. Não há migration nova. O worker o recupera filtrando client_id, project_id e a revisão base exata. Não cria PRODUCT.md ou DESIGN.md dentro de src/public nem inclui o contrato no artefato publicado. Em refinamento, usa o contrato e as fontes atuais para preservar a identidade.

## Revisão com evidência

Com a skill ativa, a crítica separada recebe screenshots desktop/mobile reais, briefing e contrato privado, além das referências completas de craft-floor, audit e critique. Exige oito dimensões: especificidade da identidade, cobertura do briefing, hierarquia, tipografia, cor, composição, imagens e responsividade. Cada dimensão exige uma observação concreta; falha em uma impede aprovação, mesmo se o booleano geral vier como verdadeiro. Um simples JSON dizendo que passou, sem evidências, é recusado.

A validação estática e o QA técnico existentes continuam ativos. Screenshot não prova funcionamento do formulário, performance, navegação por teclado ou contraste calculado: a crítica é instruída a não inventar essas medições. Sem E2B configurado, a saída é explicitamente um rascunho com revisão visual pendente. Não há promessa tecnicamente sustentável de “jamais genérico”; há direcionamento forte, evidências exigidas e reprovação controlada.

## Edição e custo

Edições preservam a identidade, carregam integralmente skill + craft-floor e os guias pertinentes ao pedido; toda referência continua acessível. Isso segue o carregamento por tarefa do próprio Impeccable: aplicar o método inteiro não significa executar comandos incompatíveis (por exemplo bolder e quieter) em toda mudança.

As referências estáveis precedem dados variáveis para favorecer cache do provedor, quando suportado, sem afirmar cache hit ou desconto não medido. Criação usa mais contexto de propósito; a prioridade é construir a direção corretamente. Fontes completas são incluídas quando couberem; cortes de fontes são marcados com offset para read, sem cortes silenciosos dos fundamentos. O orçamento multimodal passa a rejeitar excedente real em vez de limitar artificialmente a estimativa ao tamanho do contexto.

## Validação local

Testes cobrem integridade dos documentos, carregamento integral, novo site versus site pequeno existente, refinamento versus redesign, consulta paginada, toggle real, skills adicionais, atualização de override legado, direção privada antes de código, isolamento client/projeto/revisão, contrato na crítica e recusa de aprovação sem evidências.

Até o primeiro gate completo desta integração: 1.297 testes passaram (31 skipped), TypeScript sem erros e lint focado sem erros. Resultado final de build/testes registrado no progresso do projeto.

Não foi executada geração real paga ou publicação. Para validar qualidade percebida e custo real, usar briefing e logo reais em ambiente autorizado; medir fidelidade ao pedido, diferenciação entre negócios, render desktop/mobile, interações, tokens e tempo. Reiniciar o worker dedicado para carregar o código atualizado.

## Catálogo preservado

| Documento oficial | Caracteres integrais |
| --- | ---: |
| [skill/SKILL.src.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/SKILL.src.md) | 12952 |
| [skill/reference/adapt.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/adapt.md) | 11310 |
| [skill/reference/adapt.native.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/adapt.native.md) | 3919 |
| [skill/reference/android.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/android.md) | 4892 |
| [skill/reference/animate.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/animate.md) | 5245 |
| [skill/reference/audit.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/audit.md) | 7854 |
| [skill/reference/audit.native.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/audit.native.md) | 7690 |
| [skill/reference/bolder.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/bolder.md) | 3457 |
| [skill/reference/clarify.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/clarify.md) | 4607 |
| [skill/reference/colorize.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/colorize.md) | 4550 |
| [skill/reference/component-review.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/component-review.md) | 7864 |
| [skill/reference/craft-floor.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/craft-floor.md) | 7326 |
| [skill/reference/craft.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/craft.md) | 543 |
| [skill/reference/critique.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/critique.md) | 45143 |
| [skill/reference/delight.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/delight.md) | 3729 |
| [skill/reference/distill.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/distill.md) | 5605 |
| [skill/reference/doctor.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/doctor.md) | 5447 |
| [skill/reference/document.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/document.md) | 27383 |
| [skill/reference/extract.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/extract.md) | 3309 |
| [skill/reference/generate.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/generate.md) | 12993 |
| [skill/reference/harden.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/harden.md) | 9457 |
| [skill/reference/hooks.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/hooks.md) | 13854 |
| [skill/reference/init.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/init.md) | 11412 |
| [skill/reference/ios.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/ios.md) | 4641 |
| [skill/reference/layout.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/layout.md) | 5157 |
| [skill/reference/live-setup.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/live-setup.md) | 8169 |
| [skill/reference/live.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/live.md) | 36219 |
| [skill/reference/mode-operate.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/mode-operate.md) | 4483 |
| [skill/reference/mode-persuade.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/mode-persuade.md) | 3686 |
| [skill/reference/mode-read.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/mode-read.md) | 4396 |
| [skill/reference/new-work.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/new-work.md) | 61136 |
| [skill/reference/onboard.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/onboard.md) | 7755 |
| [skill/reference/operate.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/operate.md) | 5194 |
| [skill/reference/optimize.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/optimize.md) | 7623 |
| [skill/reference/overdrive.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/overdrive.md) | 8996 |
| [skill/reference/polish.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/polish.md) | 6612 |
| [skill/reference/quieter.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/quieter.md) | 4839 |
| [skill/reference/region-map.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/region-map.md) | 3308 |
| [skill/reference/routing.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/routing.md) | 3301 |
| [skill/reference/shape.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/shape.md) | 3547 |
| [skill/reference/typeset.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/typeset.md) | 5248 |
| [skill/reference/visualize.md](https://github.com/pbakaus/impeccable/blob/87a6ab0c145adb85cbd428a99fa1377305e0818d/skill/reference/visualize.md) | 12968 |
