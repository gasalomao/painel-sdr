import { createHash } from "node:crypto";

/**
 * OTIMIZAÇÃO #1: Loop Detector
 *
 * Detecta loops de leitura/validação e bloqueia após 2 repetições (vs 6 no código original).
 * Economiza ~40% de tokens em casos de loop.
 */
export class AgentLoopDetector {
  private readonly inspections = new Map<string, number>();

  constructor(private readonly maxRepeats: number = 2) {}

  /**
   * Detecta se uma operação está sendo repetida sem progresso.
   */
  detect(
    toolName: string,
    args: unknown,
    files: Record<string, string>
  ): { shouldBlock: boolean; repeatCount: number; message?: string } {
    const fingerprint = this.createFingerprint(toolName, args, files);
    const repeats = (this.inspections.get(fingerprint) ?? 0) + 1;
    this.inspections.set(fingerprint, repeats);

    // Primeira vez vendo esta operação - não é repetição
    if (repeats === 1) {
      return { shouldBlock: false, repeatCount: repeats };
    }

    // Primeiro aviso após primeira repetição (2ª vez vendo)
    if (repeats === 2) {
      return {
        shouldBlock: false,
        repeatCount: repeats,
        message: `⚠️ Leitura repetida detectada. Use as linhas exatas do diagnóstico com read(start_line/end_line), aplique patch literal único e revalide. Não estime offsets nem reescreva arquivo inteiro a partir de recortes.`
      };
    }

    // Bloqueio após maxRepeats (padrão: 3ª vez = 2 repetições)
    if (repeats > this.maxRepeats) {
      return {
        shouldBlock: true,
        repeatCount: repeats,
        message: `🚫 Execução interrompida: ${repeats} leituras idênticas sem progresso. Retome com outro modelo; use as linhas diagnosticadas e patch mínimo, sem repetir a mesma inspeção.`
      };
    }

    return { shouldBlock: false, repeatCount: repeats };
  }

  private createFingerprint(toolName: string, args: unknown, files: Record<string, string>): string {
    return createHash("sha256")
      .update(toolName)
      .update(JSON.stringify(args) ?? "")
      .update(JSON.stringify(files))
      .digest("hex");
  }

  /** Reseta o detector (útil para novos runs) */
  reset(): void {
    this.inspections.clear();
  }

  /** Retorna estatísticas de detecção */
  getStats(): { totalInspections: number; uniqueOperations: number } {
    const total = Array.from(this.inspections.values()).reduce((sum, count) => sum + count, 0);
    return {
      totalInspections: total,
      uniqueOperations: this.inspections.size
    };
  }
}
