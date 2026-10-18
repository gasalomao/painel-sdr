# Spec: lead-whatsapp-photos

Status: proposta para revisão. Depende de lead-workspace, conforme CAPABILITY-MAP.md.

## Objetivo

Reconhecer o lead pela foto real do WhatsApp na ficha e nos cartões, com sincronização manual segura e custo controlado de chamadas e armazenamento.

## Critérios de sucesso

1. Usar a foto real do WhatsApp quando disponível para o número do lead e para uma conexão pertencente ao cliente autenticado. Sem foto ou em falha de carregamento, usar iniciais; não usar retrato fictício.
2. Reutilizar fotos já conhecidas em contatos/conversas antes de consultar o provedor. Preservar imagens comerciais existentes como dados distintos, sem sobrescrevê-las.
3. Botão individual na ficha e ação de sincronizar fotos em /leads. A ação em lote apresenta escopo e progresso reais, resumo de atualizadas/sem foto/ignoradas/falhas e permite interromper futuras etapas sem desfazer o que já terminou.
4. Sincronizar todos os leads elegíveis em lotes paginados, sem depender apenas dos cartões carregados. Filtros/seleção só alteram esse escopo quando explicitamente apresentados ao usuário.
5. Limitar lote, concorrência, tempo de chamada e frequência de repetição. Repetidos cliques não disparam trabalho simultâneo ilimitado para o mesmo cliente/conexão.
6. Guardar referência de imagem e metadados pequenos de cache. Não gravar binários/base64 no Postgres nem baixar cópias em massa.
7. Fotos já recentes são reutilizadas. Ausência confirmada pode ter cache curto; erro de rede/autorização não é convertido em ausência definitiva nem apaga uma foto válida.
8. Telefone ausente/inválido, privacidade, conexão desconectada ou provedor sem suporte produzem estado claro. Não chamar API externa para números inválidos.
9. Abrir o Kanban não chama a Evolution por cartão. Imagens carregam sob demanda no navegador com tamanho reservado e fallback sem ciclos de erro.
10. Cancelamento/navegação e falhas parciais não deixam a interface presa nem apresentam sucesso total indevido. Atualizar foto na ficha, lista e cartões sem reload completo.
11. Endpoint exige sessão e verifica propriedade de cliente, lead e conexão. Não aceitar URL arbitrária para fetch no servidor, não expor chave da Evolution e não criar cache compartilhado sem escopo.
12. Carregamento de imagem não deve enviar informações sensíveis do painel via Referer. Validar URLs e esquemas segundo o contrato real do provedor.

## Contratos e decisões técnicas

- lead-workspace consome URL/estado da foto; não conhece chaves de integração.
- Reutilizar cliente Evolution, normalização de números e cache existentes. Confirmar o contrato de foto no adaptador efetivamente utilizado pelo projeto.
- URL não é garantia de disponibilidade permanente: tratar expiração e erro visual com fallback e nova sincronização explícita.
- Duração do cache, limites de lote e estratégia de retomada serão fixados no plano com base nos mecanismos existentes.
- Nova coluna/tabela só se estruturas atuais não atenderem; apresentar essa necessidade para aprovação antes de alterar schema.

## Stack e estrutura

Next.js 16, React 19, TypeScript 5, Supabase e integração WhatsApp existente. Interface em src/app/leads/, endpoint em src/app/api/, adaptadores/cache em src/lib/, testes em src/lib/__tests__/.

## Comandos

- Testes offline: npm run test -- --maxWorkers=2 --minWorkers=1 --hookTimeout=60000
- Tipos: npx tsc --noEmit
- Lint: npm run lint
- Build: npm run build
- Desenvolvimento: npm run dev

## Estilo

Tipos explícitos, sem any, funções pequenas e padrões existentes. Nenhum SDK ou fila novos se API HTTP e infraestrutura atuais atenderem.

```ts
export function isPhotoCacheFresh(checkedAt: string, now: number, ttlMs: number): boolean {
  return Number.isFinite(Date.parse(checkedAt)) && now - Date.parse(checkedAt) < ttlMs;
}
```

## Testes

Mocks offline do provedor para: foto válida, privacidade/ausência, timeout, desconexão, URL inválida, cache recente/expirado, limites e cancelamento. APIs cobrem isolamento e adulteração de IDs. Componentes cobrem fallback de imagem, progresso honesto e falhas parciais. Validar em navegador com cartões/ficha reais e imagens de teste. Chamadas reais ao WhatsApp exigem opt-in explícito.

## Limites

- Sempre: autenticar, validar número e conexão, limitar chamadas, preservar foto válida em erro e informar resultados parciais.
- Pedir antes: schema, nova dependência, serviços externos para teste, commit ou deploy.
- Nunca: usar conexão de outro cliente, persistir imagens binárias, buscar URL arbitrária, enviar mensagem ao lead ou disparar sincronização externa automática durante testes.

## Fora do escopo

Importação de contatos em massa, cópia de mídias das conversas, reconhecimento facial, hospedagem própria de fotografias e sincronização de mensagens.

## Levantamento técnico

Adaptador efetivo e armazenamento/cache existentes serão documentados após o levantamento do código.
