# Contribuindo para o Painel SDR

Obrigado por querer contribuir! Este guia descreve o processo padrão.

## Pré-requisitos

- Node.js 20+
- npm 10+
- Um projeto Supabase (para testes)

## Setup Local

```bash
git clone https://github.com/gasalomao/painel-sdr.git
cd painel-sdr
npm install
cp .env.example .env.local  # preencha com suas credenciais
npm run dev
```

## Padrão de Commits (Conventional Commits)

Usamos [Conventional Commits](https://www.conventionalcommits.org/):

```
<tipo>(<escopo>): <descrição>
```

**Tipos:**

| Tipo | Uso |
|------|-----|
| `feat` | Nova funcionalidade |
| `fix` | Correção de bug |
| `docs` | Documentação |
| `refactor` | Refatoração (sem mudança de comportamento) |
| `perf` | Melhoria de performance |
| `test` | Adição/correção de testes |
| `chore` | Tarefas de manutenção |
| `ci` | CI/CD |

**Exemplos:**
```
feat(chat): adiciona indicador de digitação em tempo real
fix(agent): corrige loop infinito no RAG quando contexto vazio
docs(readme): atualiza instruções de deploy
```

## Antes de Abrir um Pull Request

1. **Lint passe sem erros:**
   ```bash
   npm run lint
   ```

2. **Testes passem:**
   ```bash
   npm test
   ```

3. **Build passe:**
   ```bash
   npm run build
   ```

4. **Não commite secrets** — nunca adicione `.env.local`, chaves de API, ou credenciais.

## Checklist do Pull Request

- [ ] Código segue o estilo existente
- [ ] Lint passa (`npm run lint`)
- [ ] Testes passam (`npm test`)
- [ ] Sem secrets/credenciais no código
- [ ] Commits seguem Conventional Commits
- [ ] PR referencia a issue relacionada (se aplicável)

## Estrutura de Pastas

Consulte o [README](README.md#estrutura-do-projeto) para entender a organização do código antes de contribuir.

## Reportando Bugs

Abra uma [Issue](https://github.com/gasalomao/painel-sdr/issues/new?template=bug_report.md) com:
- Descrição clara do problema
- Passos para reproduzir
- Comportamento esperado vs. atual
- Screenshots (se aplicável)
- Ambiente (browser, OS, Node.js version)
