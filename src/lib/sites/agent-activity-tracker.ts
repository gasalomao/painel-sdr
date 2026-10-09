/**
 * Integração do Activity Logger no Agent Runtime
 *
 * Este arquivo adiciona logging detalhado em tempo real no agent.ts
 */

import { activityLogger, type ActivityEvent } from "./activity-logger";
import type { WebsiteRun } from "./types";

/**
 * Wrapper para adicionar activity logging ao agent runtime
 */
export class AgentActivityTracker {
  private runId: string;
  private activeOperations: Map<string, string> = new Map();

  constructor(run: WebsiteRun) {
    this.runId = run.id;
  }

  // ==================== TOOL TRACKING ====================

  async trackTool<T>(
    toolName: string,
    params: Record<string, any> | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const operationId = activityLogger.toolStart(toolName, params);
    this.activeOperations.set(operationId, toolName);

    try {
      const result = await operation();
      activityLogger.toolComplete(operationId, result);
      this.activeOperations.delete(operationId);

      // Persiste no banco
      await this.persistActivity(activityLogger.getEvents().slice(-2));

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLogger.toolError(operationId, errorMessage);
      this.activeOperations.delete(operationId);

      await this.persistActivity(activityLogger.getEvents().slice(-1));
      throw error;
    }
  }

  // ==================== MODEL TRACKING ====================

  async trackModelCall<T>(
    modelId: string,
    purpose: string,
    operation: () => Promise<T>,
    extractUsage?: (result: T) => { inputTokens?: number; outputTokens?: number }
  ): Promise<T> {
    const operationId = activityLogger.modelStart(modelId, purpose);
    this.activeOperations.set(operationId, `model-${modelId}`);

    try {
      const result = await operation();

      const usage = extractUsage ? extractUsage(result) : undefined;
      activityLogger.modelComplete(operationId, usage);
      this.activeOperations.delete(operationId);

      await this.persistActivity(activityLogger.getEvents().slice(-2));

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLogger.modelError(operationId, errorMessage);
      this.activeOperations.delete(operationId);

      await this.persistActivity(activityLogger.getEvents().slice(-1));
      throw error;
    }
  }

  trackModelThinking(operationId: string, thought: string): void {
    activityLogger.modelThinking(operationId, thought);
    // Não precisa persistir cada thinking, apenas no final
  }

  // ==================== VALIDATION TRACKING ====================

  async trackValidation<T>(
    type: "static" | "build",
    operation: () => Promise<T>,
    extractResult?: (result: T) => { passed: boolean; errors: string[]; warnings: string[] }
  ): Promise<T> {
    const operationId = activityLogger.validationStart(type);

    try {
      const result = await operation();

      if (extractResult) {
        const validationResult = extractResult(result);
        activityLogger.validationComplete(operationId, validationResult);
      }

      await this.persistActivity(activityLogger.getEvents().slice(-2));

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLogger.toolError(operationId, errorMessage);

      await this.persistActivity(activityLogger.getEvents().slice(-1));
      throw error;
    }
  }

  // ==================== BUILD TRACKING ====================

  async trackBuild<T>(
    operation: (progress: (step: string) => void) => Promise<T>
  ): Promise<T> {
    const operationId = activityLogger.buildStart();

    const progressCallback = (step: string) => {
      activityLogger.buildProgress(operationId, step);
      // Persiste steps importantes
      if (step.includes("concluído") || step.includes("erro")) {
        this.persistActivity(activityLogger.getEvents().slice(-1));
      }
    };

    try {
      const result = await operation(progressCallback);
      activityLogger.buildComplete(operationId, true);

      await this.persistActivity(activityLogger.getEvents().slice(-2));

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      activityLogger.buildError(operationId, errorMessage);

      await this.persistActivity(activityLogger.getEvents().slice(-1));
      throw error;
    }
  }

  // ==================== OTHER TRACKING ====================

  checkpoint(name: string): void {
    activityLogger.checkpointCreated(name);
    this.persistActivity(activityLogger.getEvents().slice(-1));
  }

  revision(revisionId: string): void {
    activityLogger.revisionCreated(revisionId);
    this.persistActivity(activityLogger.getEvents().slice(-1));
  }

  thinking(thought: string): void {
    activityLogger.thinking(thought);
    // Thinking não precisa persistir imediatamente
  }

  planning(plan: string): void {
    activityLogger.planning(plan);
    this.persistActivity(activityLogger.getEvents().slice(-1));
  }

  info(message: string): void {
    activityLogger.info(message);
    this.persistActivity(activityLogger.getEvents().slice(-1));
  }

  error(message: string): void {
    activityLogger.error(message);
    this.persistActivity(activityLogger.getEvents().slice(-1));
  }

  // ==================== PERSISTENCE ====================

  private async persistActivity(events: ActivityEvent[]): Promise<void> {
    try {
      await fetch(`/api/sites/runs/${this.runId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
    } catch (error) {
      // Falha na persistência não deve quebrar o fluxo
      console.error("Failed to persist activity:", error);
    }
  }

  /**
   * Obtém resumo de uso total
   */
  getUsageSummary(): { inputTokens: number; outputTokens: number } {
    return activityLogger.getTotalUsage();
  }

  /**
   * Limpa eventos do logger (ao final do run)
   */
  clear(): void {
    activityLogger.clear();
  }
}

/**
 * Exemplo de integração no agent.ts:
 *
 * // No início do run:
 * const tracker = new AgentActivityTracker(run);
 *
 * // Ao chamar ferramentas:
 * const files = await tracker.trackTool("list", {}, async () => {
 *   return tools.execute("list", {});
 * });
 *
 * // Ao chamar modelo:
 * const response = await tracker.trackModelCall(
 *   modelId,
 *   "gerando código",
 *   async () => chat(messages, tools),
 *   (result) => ({ inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens })
 * );
 *
 * // Ao validar:
 * const validation = await tracker.trackValidation("static", async () => {
 *   return validateWebsiteContent(files);
 * }, (result) => ({
 *   passed: result.passed,
 *   errors: result.errors,
 *   warnings: result.warnings
 * }));
 *
 * // Ao fazer build:
 * const build = await tracker.trackBuild(async (progress) => {
 *   progress("Iniciando sandbox E2B...");
 *   const sandbox = await createSandbox();
 *
 *   progress("Instalando dependências...");
 *   await sandbox.run("npm install");
 *
 *   progress("Executando build...");
 *   await sandbox.run("npm run build");
 *
 *   progress("Capturando screenshots...");
 *   const screenshots = await captureScreenshots(sandbox);
 *
 *   return { sandbox, screenshots };
 * });
 */
