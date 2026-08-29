# AUDIT RISK REGISTER

## Escala

- CRITICAL: perda/corrupção de dados, acesso indevido amplo ou falha central.
- HIGH: impacto importante em funcionalidade, segurança ou confiabilidade.
- MEDIUM: impacto limitado ou condição operacional específica.
- LOW: risco pequeno.

## Riscos de execução da própria auditoria

| ID | Risco | Severidade | Evidência | Mitigação | Estado |
|---|---|---|---|---|---|
| AR-001 | `npm test` tocar DB/IA/rede/browser real | HIGH | setup lê env local e suites live estão no include | classificar 69 suites; executar subset explícito | ATIVO |
| AR-002 | iniciar app disparar schedulers/mensagens/sync | CRITICAL | `src/instrumentation.ts` inicia timers | não iniciar servidor sem env sandbox e jobs desabilitados | ATIVO |
| AR-003 | `npm run build` modificar arquivo rastreado | MEDIUM | prebuild chama gerador SQL | checkpoint Git; testar gerador em temp antes | ATIVO |
| AR-004 | scripts operacionais escreverem no Supabase | CRITICAL | backfill/recovery documentam writes | não executar | ATIVO |
| AR-005 | SQL operacional destruir dados | CRITICAL | security contém TRUNCATE/DROP/restore/recreate | nunca executar; só análise estática | ATIVO |
| AR-006 | browser QA realizar ações reais | HIGH | app integra WhatsApp/Google/IA | exigir ambiente isolado e dados descartáveis | ATIVO |
| AR-007 | expor secrets em relatório/tool output | CRITICAL | env local e possível doc tracked | mascarar; reportar apenas localização/tipo | ATIVO |
| AR-008 | formatter/auto-fix alterar arquivos não relacionados | MEDIUM | lint tooling disponível | nunca usar `--fix`/`--write` | MITIGADO |

## Riscos do sistema em triagem

| ID | Risco | Severidade candidata | Confiança | Dependência de ambiente | Estado |
|---|---|---|---|---|---|
| SR-001 | bypass de auth por header interno | CRITICAL | 95% | não | PROVÁVEL |
| SR-002 | admin sem autorização local | CRITICAL | 90% | combinado com SR-001 | PROVÁVEL |
| SR-003 | secrets em arquivo rastreado/histórico | CRITICAL | 85% | valores podem já ter sido rotacionados | PROVÁVEL |
| SR-004 | RLS/grants quebram isolamento | CRITICAL | 90% repo | estado DB real | NÃO VALIDADO EM PROD |
| SR-005 | webhooks fail-open | HIGH/CRITICAL | 90% | config runtime | PROVÁVEL |
| SR-006 | Cloud webhook sem tenant | HIGH | 90% | schema/defaults aplicados | PROVÁVEL |
| SR-007 | JWT revogado permanece válido | HIGH | 90% | não | PROVÁVEL |
| SR-008 | IDs/referências atravessam tenants | HIGH | 80% | RLS pode mitigar parcialmente | PROVÁVEL |
| SR-009 | SSRF via scraper/webhook URL | HIGH | 85% | rede de deploy | PROVÁVEL |
| SR-010 | schedulers duplicam em múltiplas réplicas | HIGH | 90% código | número de réplicas | CONDICIONAL |
| SR-011 | testes padrão têm efeitos externos | HIGH | 90% | env/guards | PROVÁVEL |
| SR-012 | build aceita type errors | MEDIUM/HIGH | 100% | type errors atuais desconhecidos | CONFIRMADO CONFIG |
| SR-013 | SQL embutido obsoleto | MEDIUM/HIGH | 95% | conteúdo divergente | PROVÁVEL |
| SR-014 | worker BullMQ inoperante | MEDIUM | 85% | deploy externo desconhecido | PROVÁVEL |
| SR-015 | Node/Puppeteer engine incompatível | HIGH | 85% | caminho scraper | PROVÁVEL |
| SR-016 | credenciais de provider em JSON/filesystem sem proteção suficiente | HIGH | 85% | grants/at-rest controls | PROVÁVEL |
| SR-017 | mídia/PII em buckets públicos | HIGH | 85% | bucket state/policies | NÃO VALIDADO EM PROD |
| SR-018 | estado singleton do scraper cruza tenants | HIGH | 85% | concorrência multiusuário | PROVÁVEL |

## Riscos residuais inevitáveis nesta fase

- Repositório não prova o estado do Supabase real.
- Repositório não prova a topologia Easypanel/produção.
- Teste offline não prova integrações externas.
- Fixes de RLS/schema/scheduler provavelmente exigirão mudanças high-risk e rollout.
- Rotação de secrets exige acesso operacional fora do workspace.

## Requisitos para reduzir riscos

1. Provar auth/header/admin por testes offline.
2. Fazer inventário read-only do DB real com credenciais e autorização apropriadas.
3. Separar testes offline de live.
4. Adicionar typecheck como gate independente.
5. Definir ambiente staging sem mensagens/cobranças/contatos reais.
6. Definir rollback antes de qualquer migration ou mudança de protocolo.
