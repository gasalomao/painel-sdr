---
name: website-qa
description: Verificação funcional de sites do Site Studio separando testes executados de pendências. Use antes de considerar uma geração concluída ou uma publicação pronta.
---
# QA de Sites

Compilação, links, navegação, formulários, CTA, teclado, estados vazios e erros — em desktop e mobile. Teste de mudança de estado completa, não presença de elemento.

## Quando usar
- Concluir uma geração/edição de site.
- Validar antes de publicar.
- Reportar status de um build/preview.

## Processo
1. Verifique compilação e render reais no ambiente isolado autorizado (E2B) quando disponível; código gerado nunca executa fora dele.
2. Percorra os fluxos: navegação entre seções, CTA com destino correto, formulário com sucesso/erro, links externos, estados vazios, foco e operação por teclado.
3. Teste mudanças de estado completas: clique → resposta visível → estado final correto; não basta o elemento existir.
4. Separe o relatório em: testes executados (com resultado), inspeções de código e verificações pendentes (e por quê).

## Checks
- Build, preview, screenshot e publicação só são declarados bem-sucedidos com resultado real da ferramenta correspondente.
- Desktop e mobile em cada fluxo essencial.

## Anti-patterns
- Declarar sucesso sem output de ferramenta.
- Testar só presença de elementos (não estados).
- Executar código gerado fora do sandbox autorizado.
- Marcar pendência como verificada.

## DoD
Relatório com executados × pendentes explícito; nenhum resultado simulado; bloqueadores antes de publicação claramente listados.
