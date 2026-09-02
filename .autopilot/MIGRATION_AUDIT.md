# Migration Audit

Status: `PARTIAL`.

## Evidência produzida

- `migrations/SETUP_COMPLETO.sql` é a fonte canônica consumida por `scripts/build-setup-sql.mjs`.
- Fonte ausente retorna exit 1 e preserva eventual artefato anterior; não há mais fallback silencioso para arquivo homônimo na raiz.
- O drift de `openrouter_keys` e `ai_combos` foi reconciliado na fonte canônica antes da regeneração.
- `src/lib/setup-sql.ts` foi regenerado a partir da fonte canônica.
- `src/lib/__tests__/build-setup-sql.test.ts`: 3 testes passaram, cobrindo precedência da fonte, colunas exigidas pelo runtime e fail-fast sem perda do artefato anterior.
- `npm run build`: exit 0 após executar o gerador corrigido; 24 warnings preexistentes de tracing.
- Migrations de RLS/grants permanecem divergentes; estado implantado é `BLOCKED` sem introspecção.

## Provas exigidas

1. Fonte canônica única e build fail-fast.
2. Banco vazio para schema completo e smoke.
3. Upgrade incremental quando um schema antigo reproduzível existir.
4. Auditoria de tabelas, índices, constraints, triggers, RPCs, policies e grants.
5. Versão PostgreSQL local/staging e mínimo seguro registrado com fonte oficial.
