/**
 * Exemplo de integração completa do Activity Logger no agent.ts
 *
 * Este arquivo mostra como integrar o sistema de logs em tempo real
 * no fluxo existente do agent runtime
 */

import { AgentActivityTracker } from "./agent-activity-tracker";
import type { WebsiteRun } from "./types";

/**
 * Exemplo de como modificar o agent.ts para incluir activity logging
 */

// ==================== NO INÍCIO DO RUN ====================

export async function runWebsiteAgent(run: WebsiteRun, dependencies: WebsiteAgentDependencies) {
  // Cria tracker para este run
  const tracker = new AgentActivityTracker(run);

  try {
    tracker.info("Iniciando processamento do run...");

    // Carrega contexto
    const input = await tracker.trackTool("carregar contexto", undefined, async () => {
      return dependencies.load(run);
    });

    tracker.info(`Projeto: ${input.project.name}`);
    tracker.info(`${Object.keys(input.files).length} arquivos no workspace`);

    // ... resto do código

  } catch (error) {
    tracker.error(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    tracker.clear();
  }
}

// ==================== AO EXECUTAR FERRAMENTAS ====================

// Antes (sem logging):
const files = await tools.execute("list", {});

// Depois (com logging):
const files = await tracker.trackTool("list", {}, async () => {
  return tools.execute("list", {});
});

// ==================== AO CHAMAR MODELO ====================

// Antes (sem logging):
const response = await chat(messages, tools);

// Depois (com logging):
const response = await tracker.trackModelCall(
  modelId,
  "gerando código do site",
  async () => chat(messages, tools),
  (result) => ({
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens
  })
);

// ==================== AO VALIDAR ====================

// Antes (sem logging):
const validation = validateWebsiteContent(files);

// Depois (com logging):
const validation = await tracker.trackValidation(
  "static",
  async () => validateWebsiteContent(files),
  (result) => ({
    passed: result.passed,
    errors: result.errors,
    warnings: result.warnings
  })
);

if (!validation.passed) {
  tracker.error(`Validação falhou: ${validation.errors.length} erro(s)`);
  validation.errors.forEach(err => tracker.error(err));
}

// ==================== AO FAZER BUILD ====================

// Antes (sem logging):
const build = await buildWebsite(files);

// Depois (com logging):
const build = await tracker.trackBuild(async (progress) => {
  progress("Preparando ambiente de build isolado...");

  progress("Criando sandbox E2B...");
  const sandbox = await createE2BSandbox();

  progress("Enviando arquivos para sandbox...");
  await uploadFilesToSandbox(sandbox, files);

  progress("Instalando dependências (npm install)...");
  await sandbox.run("npm install");

  progress("Executando build (npm run build)...");
  const buildResult = await sandbox.run("npm run build");

  if (buildResult.exitCode !== 0) {
    throw new Error(`Build falhou: ${buildResult.stderr}`);
  }

  progress("Build concluído; capturando screenshots...");
  const screenshots = await captureScreenshots(sandbox);

  progress("Gerando artifact final...");
  const artifact = await generateArtifact(sandbox);

  return { screenshots, artifact };
});

// ==================== AO CRIAR CHECKPOINT ====================

// Antes (sem logging):
await saveCheckpoint(run, { name: "before-validation", files });

// Depois (com logging):
await saveCheckpoint(run, { name: "before-validation", files });
tracker.checkpoint("before-validation");

// ==================== AO CRIAR REVISÃO ====================

// Antes (sem logging):
const revision = await createRevision(run.project_id, files, "Site gerado com sucesso");

// Depois (com logging):
const revision = await createRevision(run.project_id, files, "Site gerado com sucesso");
tracker.revision(revision.id);

// ==================== PENSAMENTO DO AGENT ====================

// Durante o processamento, adicione thoughts:
tracker.thinking("Analisando estrutura do site solicitado...");
tracker.thinking("Decidindo entre layout grid vs flexbox...");
tracker.thinking("Verificando se Impeccable Design está ativo...");

// Durante planejamento:
tracker.planning("Criar 4 seções: home, serviços, sobre, contato");
tracker.planning("Usar paleta verde natureza + tons terra");
tracker.planning("Tipografia fluida com clamp()");

// ==================== EXEMPLO COMPLETO DE FLUXO ====================

async function executeWebsiteRun(run: WebsiteRun): Promise<void> {
  const tracker = new AgentActivityTracker(run);

  try {
    // 1. Carrega contexto
    tracker.info("Carregando contexto do projeto...");
    const input = await tracker.trackTool("get_context", undefined, async () => {
      return loadProjectContext(run);
    });

    // 2. Analisa prompt
    tracker.thinking("Analisando requisição do usuário...");
    const isSimple = isSimpleWebsiteRequest(input.prompt);
    const patchOnly = isSimple && hasExistingSite(input.files);

    if (patchOnly) {
      tracker.info("Modo Patch Only ativado (edição cirúrgica)");
    } else {
      tracker.info("Modo Normal ativado (criação/edição completa)");
    }

    // 3. Verifica skills
    const hasImpeccable = input.activeSkills?.some(s => s.slug === "impeccable-design");
    if (hasImpeccable) {
      tracker.info("Skill Impeccable Design ativa");

      // Lê referências
      await tracker.trackTool("read_design_reference", { name: "color" }, async () => {
        return tools.execute("read_design_reference", { name: "color", offset: 0, limit: 12000 });
      });

      await tracker.trackTool("read_design_reference", { name: "typography" }, async () => {
        return tools.execute("read_design_reference", { name: "typography", offset: 0, limit: 12000 });
      });
    }

    // 4. Loop principal do agent
    let turn = 0;
    const maxTurns = patchOnly ? 3 : 12;

    while (turn < maxTurns) {
      turn++;
      tracker.info(`Rodada ${turn}/${maxTurns}`);

      // Chama modelo
      const response = await tracker.trackModelCall(
        input.model.id,
        turn === 1 ? "análise inicial e planejamento" : "continuando edição",
        async () => chat(messages, tools),
        (result) => ({
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens
        })
      );

      // Processa tool calls
      if (response.tool_calls) {
        for (const toolCall of response.tool_calls) {
          const { name, arguments: args } = toolCall.function;

          await tracker.trackTool(name, args, async () => {
            return tools.execute(name, args);
          });
        }
      }

      // Verifica se terminou
      if (response.finish_reason === "stop") {
        tracker.info("Agent finalizou edições");
        break;
      }
    }

    // 5. Validação
    const validation = await tracker.trackValidation(
      "static",
      async () => validateWebsiteContent(files),
      (result) => ({
        passed: result.passed,
        errors: result.errors,
        warnings: result.warnings
      })
    );

    if (!validation.passed) {
      throw new Error("Validação estática falhou");
    }

    // 6. Build
    const build = await tracker.trackBuild(async (progress) => {
      progress("Criando sandbox E2B...");
      const sandbox = await createE2BSandbox();

      progress("Enviando arquivos...");
      await uploadFiles(sandbox, files);

      progress("npm install...");
      await sandbox.run("npm install");

      progress("npm run build...");
      await sandbox.run("npm run build");

      progress("Capturando screenshots...");
      const screenshots = await captureScreenshots(sandbox);

      return { screenshots };
    });

    // 7. Cria revisão
    const revision = await createRevision(run.project_id, files, "Site gerado");
    tracker.revision(revision.id);

    tracker.info("✅ Run concluído com sucesso!");

    // 8. Resumo final
    const usage = tracker.getUsageSummary();
    tracker.info(`Uso total: ${usage.inputTokens} → ${usage.outputTokens} tokens`);

  } catch (error) {
    tracker.error(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    tracker.clear();
  }
}
