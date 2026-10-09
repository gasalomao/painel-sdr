/**
 * Sistema de Activity Logging em tempo real para Site Studio
 * Inspirado no Lovable - mostra exatamente o que o agent está fazendo
 */

export type ActivityType =
  | "tool_start"
  | "tool_complete"
  | "tool_error"
  | "model_start"
  | "model_thinking"
  | "model_complete"
  | "model_error"
  | "validation_start"
  | "validation_complete"
  | "validation_error"
  | "build_start"
  | "build_progress"
  | "build_complete"
  | "build_error"
  | "checkpoint_created"
  | "revision_created"
  | "thinking"
  | "planning"
  | "error"
  | "info";

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  message: string;
  timestamp: number;
  details?: Record<string, any>;
  status?: "pending" | "success" | "error";
  duration?: number;
}

export class ActivityLogger {
  private events: ActivityEvent[] = [];
  private callbacks: Array<(event: ActivityEvent) => void> = [];
  private startTimes: Map<string, number> = new Map();

  constructor() {}

  /**
   * Registra callback para receber eventos em tempo real
   */
  onActivity(callback: (event: ActivityEvent) => void): () => void {
    this.callbacks.push(callback);
    return () => {
      const index = this.callbacks.indexOf(callback);
      if (index > -1) {
        this.callbacks.splice(index, 1);
      }
    };
  }

  /**
   * Emite evento de atividade
   */
  private emit(event: ActivityEvent): void {
    this.events.push(event);
    this.callbacks.forEach((cb) => cb(event));
  }

  /**
   * Cria ID único para rastrear ações
   */
  private createId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  // ==================== TOOL ACTIVITIES ====================

  toolStart(toolName: string, params?: Record<string, any>): string {
    const id = this.createId();
    this.startTimes.set(id, Date.now());

    const message = this.getToolStartMessage(toolName, params);

    this.emit({
      id,
      type: "tool_start",
      message,
      timestamp: Date.now(),
      details: { toolName, params },
      status: "pending",
    });

    return id;
  }

  toolComplete(id: string, result?: any): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    const originalEvent = this.events.find((e) => e.id === id);
    const toolName = originalEvent?.details?.toolName;

    this.emit({
      id: this.createId(),
      type: "tool_complete",
      message: this.getToolCompleteMessage(toolName, result),
      timestamp: Date.now(),
      details: { originalId: id, result },
      status: "success",
      duration,
    });
  }

  toolError(id: string, error: string): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    this.emit({
      id: this.createId(),
      type: "tool_error",
      message: `Erro na ferramenta: ${error}`,
      timestamp: Date.now(),
      details: { originalId: id, error },
      status: "error",
      duration,
    });
  }

  // ==================== MODEL ACTIVITIES ====================

  modelStart(modelId: string, purpose?: string): string {
    const id = this.createId();
    this.startTimes.set(id, Date.now());

    const message = purpose
      ? `Modelo ${modelId}: ${purpose}...`
      : `Modelo ${modelId}: consulta iniciada; aguardando resposta.`;

    this.emit({
      id,
      type: "model_start",
      message,
      timestamp: Date.now(),
      details: { modelId, purpose },
      status: "pending",
    });

    return id;
  }

  modelThinking(id: string, thought: string): void {
    this.emit({
      id: this.createId(),
      type: "model_thinking",
      message: `💭 ${thought}`,
      timestamp: Date.now(),
      details: { originalId: id, thought },
      status: "pending",
    });
  }

  modelComplete(id: string, usage?: { inputTokens?: number; outputTokens?: number }): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    const originalEvent = this.events.find((e) => e.id === id);
    const modelId = originalEvent?.details?.modelId;

    let message = `Modelo ${modelId || "IA"}: resposta recebida.`;
    if (usage) {
      message += ` (${usage.inputTokens || 0} → ${usage.outputTokens || 0} tokens)`;
    }

    this.emit({
      id: this.createId(),
      type: "model_complete",
      message,
      timestamp: Date.now(),
      details: { originalId: id, usage },
      status: "success",
      duration,
    });
  }

  modelError(id: string, error: string, retryCount?: number, maxRetries?: number): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;

    // Não limpar startTime se ainda houver retries - mantém o tempo original
    if (!retryCount || retryCount >= (maxRetries || 3)) {
      this.startTimes.delete(id);
    }

    const originalEvent = this.events.find((e) => e.id === id);
    const modelId = originalEvent?.details?.modelId;

    const message = retryCount && maxRetries
      ? `Modelo ${modelId || "IA"}: falha na consulta (tentativa ${retryCount}/${maxRetries}). ${error}`
      : `Modelo ${modelId || "IA"}: falha na consulta. ${error}`;

    this.emit({
      id: this.createId(),
      type: "model_error",
      message,
      timestamp: Date.now(),
      details: { originalId: id, error, retryCount, maxRetries },
      status: "error",
      duration,
    });
  }

  modelRetrying(id: string, attempt: number, maxAttempts: number, waitSeconds: number): void {
    const originalEvent = this.events.find((e) => e.id === id);
    const modelId = originalEvent?.details?.modelId;

    this.emit({
      id: this.createId(),
      type: "model_thinking",
      message: `Modelo ${modelId}: aguardando ${waitSeconds}s antes da tentativa ${attempt}/${maxAttempts}...`,
      timestamp: Date.now(),
      details: { originalId: id, attempt, maxAttempts, waitSeconds },
      status: "pending",
    });
  }

  // ==================== VALIDATION ACTIVITIES ====================

  validationStart(type: "static" | "build"): string {
    const id = this.createId();
    this.startTimes.set(id, Date.now());

    const message = type === "static"
      ? "Verificando estrutura e conteúdo..."
      : "Iniciando build de validação...";

    this.emit({
      id,
      type: "validation_start",
      message,
      timestamp: Date.now(),
      details: { validationType: type },
      status: "pending",
    });

    return id;
  }

  validationComplete(id: string, result: { passed: boolean; errors: string[]; warnings: string[] }): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    const message = result.passed
      ? `Validação técnica concluída com sucesso (${result.errors.length} erro(s), ${result.warnings.length} aviso(s)).`
      : `Validação falhou: ${result.errors.length} erro(s) encontrado(s).`;

    this.emit({
      id: this.createId(),
      type: "validation_complete",
      message,
      timestamp: Date.now(),
      details: { originalId: id, result },
      status: result.passed ? "success" : "error",
      duration,
    });
  }

  // ==================== BUILD ACTIVITIES ====================

  buildStart(): string {
    const id = this.createId();
    this.startTimes.set(id, Date.now());

    this.emit({
      id,
      type: "build_start",
      message: "Preparando ambiente de build isolado...",
      timestamp: Date.now(),
      status: "pending",
    });

    return id;
  }

  buildProgress(id: string, step: string): void {
    this.emit({
      id: this.createId(),
      type: "build_progress",
      message: step,
      timestamp: Date.now(),
      details: { originalId: id, step },
      status: "pending",
    });
  }

  buildComplete(id: string, screenshots?: boolean): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    const message = screenshots
      ? "Build concluído com sucesso; screenshots capturados."
      : "Build concluído com sucesso.";

    this.emit({
      id: this.createId(),
      type: "build_complete",
      message,
      timestamp: Date.now(),
      details: { originalId: id, screenshots },
      status: "success",
      duration,
    });
  }

  buildError(id: string, error: string): void {
    const startTime = this.startTimes.get(id);
    const duration = startTime ? Date.now() - startTime : undefined;
    this.startTimes.delete(id);

    this.emit({
      id: this.createId(),
      type: "build_error",
      message: `Build falhou: ${error}`,
      timestamp: Date.now(),
      details: { originalId: id, error },
      status: "error",
      duration,
    });
  }

  // ==================== OTHER ACTIVITIES ====================

  checkpointCreated(name: string): void {
    this.emit({
      id: this.createId(),
      type: "checkpoint_created",
      message: `Checkpoint "${name}" salvo.`,
      timestamp: Date.now(),
      details: { name },
      status: "success",
    });
  }

  revisionCreated(revisionId: string): void {
    this.emit({
      id: this.createId(),
      type: "revision_created",
      message: `Nova revisão criada: ${revisionId.substring(0, 8)}...`,
      timestamp: Date.now(),
      details: { revisionId },
      status: "success",
    });
  }

  thinking(thought: string): void {
    this.emit({
      id: this.createId(),
      type: "thinking",
      message: `🤔 ${thought}`,
      timestamp: Date.now(),
      status: "pending",
    });
  }

  planning(plan: string): void {
    this.emit({
      id: this.createId(),
      type: "planning",
      message: `📋 ${plan}`,
      timestamp: Date.now(),
      status: "pending",
    });
  }

  info(message: string): void {
    this.emit({
      id: this.createId(),
      type: "info",
      message,
      timestamp: Date.now(),
      status: "success",
    });
  }

  error(message: string): void {
    this.emit({
      id: this.createId(),
      type: "error",
      message: `❌ ${message}`,
      timestamp: Date.now(),
      status: "error",
    });
  }

  // ==================== HELPER METHODS ====================

  private getToolStartMessage(toolName: string, params?: Record<string, any>): string {
    switch (toolName) {
      case "read":
        return params?.path
          ? `Lendo arquivo: ${params.path}...`
          : "Lendo arquivo...";
      case "read_files":
        return `Lendo ${params?.paths?.length || 0} arquivos...`;
      case "write":
        return params?.path
          ? `Escrevendo arquivo: ${params.path}...`
          : "Escrevendo arquivo...";
      case "create":
        return params?.path
          ? `Criando arquivo: ${params.path}...`
          : "Criando arquivo...";
      case "patch":
        return params?.path
          ? `Editando arquivo: ${params.path}...`
          : "Editando arquivo...";
      case "delete":
        return params?.path
          ? `Deletando arquivo: ${params.path}...`
          : "Deletando arquivo...";
      case "search":
        return `Buscando nos arquivos: ${params?.query || ""}...`;
      case "list":
        return "Listando arquivos do workspace...";
      case "get_context":
        return "Carregando contexto do projeto...";
      case "assets":
        return "Listando assets disponíveis...";
      case "checkpoint":
        return `Salvando checkpoint "${params?.name}"...`;
      case "restore":
        return `Restaurando checkpoint "${params?.name}"...`;
      case "run_validation":
        return "Executando validação de código...";
      case "read_design_reference":
        return `Lendo referência de design: ${params?.name}...`;
      case "record_design_direction":
        return "Registrando direção de design...";
      default:
        return `Executando ferramenta: ${toolName}...`;
    }
  }

  private getToolCompleteMessage(toolName?: string, result?: any): string {
    switch (toolName) {
      case "read":
        return result?.path ? `Arquivo lido: ${result.path}.` : "Leitura de arquivo concluída.";
      case "read_files":
        return `Leitura de ${result?.length || 0} arquivo(s) concluída.`;
      case "write":
        return result?.path ? `Arquivo salvo: ${result.path}.` : "Arquivo salvo com sucesso.";
      case "create":
        return result?.path ? `Arquivo criado: ${result.path}.` : "Arquivo criado com sucesso.";
      case "patch":
        return result?.saved ? `Arquivo editado: ${result.saved}.` : "Arquivo editado.";
      case "delete":
        return result?.path ? `Arquivo deletado: ${result.path}.` : "Arquivo deletado.";
      case "search":
        const matches = result?.length || 0;
        return `Busca nos arquivos concluída${matches > 0 ? ` (${matches} resultado(s))` : ""}.`;
      case "list":
        const files = result?.length || 0;
        return `Listagem concluída (${files} arquivo(s)).`;
      case "get_context":
        return "Contexto do projeto carregado.";
      case "assets":
        const assets = result?.length || 0;
        return `Assets listados (${assets} disponível(is)).`;
      case "checkpoint":
        return "Checkpoint salvo.";
      case "restore":
        return "Checkpoint restaurado.";
      case "run_validation":
        const validationResult = result?.passed !== undefined
          ? result.passed
            ? `Verificação estática aprovada; renderização ainda não verificada.`
            : `Verificação estática reprovada: ${result.errors?.length || 0} erro(s).`
          : "Validação concluída.";
        return validationResult;
      case "read_design_reference":
        return result?.name ? `Referência Impeccable carregada: ${result.name}.` : "Referência de design carregada.";
      case "record_design_direction":
        return "Direção de design registrada.";
      default:
        return "Operação concluída.";
    }
  }

  /**
   * Retorna todos os eventos
   */
  getEvents(): ActivityEvent[] {
    return [...this.events];
  }

  /**
   * Limpa todos os eventos
   */
  clear(): void {
    this.events = [];
    this.startTimes.clear();
  }

  /**
   * Retorna uso total de tokens
   */
  getTotalUsage(): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;

    this.events
      .filter((e) => e.type === "model_complete" && e.details?.usage)
      .forEach((e) => {
        const usage = e.details!.usage;
        inputTokens += usage.inputTokens || 0;
        outputTokens += usage.outputTokens || 0;
      });

    return { inputTokens, outputTokens };
  }
}

// Singleton global para usar em toda a aplicação
export const activityLogger = new ActivityLogger();
