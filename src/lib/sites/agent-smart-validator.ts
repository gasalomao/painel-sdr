import { createHash } from "node:crypto";

/**
 * OTIMIZAÇÃO #4: Smart Validator
 *
 * Analisa progresso entre validações e fornece feedback inteligente.
 * Evita validações redundantes e guia o agente para correções efetivas.
 */
export class SmartValidator {
  private validationHistory: Array<{
    filesHash: string;
    errors: string[];
    timestamp: number;
  }> = [];

  /**
   * Registra uma validação.
   */
  recordValidation(files: Record<string, string>, errors: string[]): void {
    const filesHash = this.hashFiles(files);
    this.validationHistory.push({
      filesHash,
      errors,
      timestamp: Date.now()
    });

    // Mantém apenas últimas 10 validações
    if (this.validationHistory.length > 10) {
      this.validationHistory.shift();
    }
  }

  /**
   * Compara erros atuais com validação anterior.
   */
  compareErrors(currentErrors: string[]): {
    newErrors: string[];
    resolvedErrors: string[];
    persistentErrors: string[];
  } {
    if (this.validationHistory.length < 2) {
      return {
        newErrors: currentErrors,
        resolvedErrors: [],
        persistentErrors: []
      };
    }

    const previous = this.validationHistory[this.validationHistory.length - 2];
    const current = currentErrors;

    const newErrors = current.filter(e => !previous.errors.includes(e));
    const resolvedErrors = previous.errors.filter(e => !current.includes(e));
    const persistentErrors = current.filter(e => previous.errors.includes(e));

    return { newErrors, resolvedErrors, persistentErrors };
  }

  /**
   * Detecta se está em loop de validação (mesmos erros persistindo).
   */
  isInValidationLoop(): boolean {
    if (this.validationHistory.length < 3) return false;

    const last3 = this.validationHistory.slice(-3);
    const errorSets = last3.map(v => new Set(v.errors));

    // Verifica se os erros são idênticos nas últimas 3 validações
    const firstSet = errorSets[0];
    return errorSets.every(set =>
      set.size === firstSet.size &&
      Array.from(set).every(e => firstSet.has(e))
    );
  }

  /**
   * Gera feedback inteligente baseado no histórico.
   */
  getValidationFeedback(): string | null {
    if (this.validationHistory.length < 2) return null;

    const comparison = this.compareErrors(
      this.validationHistory[this.validationHistory.length - 1].errors
    );

    // Loop detectado
    if (this.isInValidationLoop()) {
      return `🔄 Loop detectado: mesmos ${comparison.persistentErrors.length} erros persistem há 3+ validações. Mude de estratégia: leia o código real (não suposições), identifique a causa raiz e corrija com patch mínimo. Se não conseguir, informe a limitação.`;
    }

    // Nenhum progresso
    if (comparison.resolvedErrors.length === 0 && comparison.persistentErrors.length > 0) {
      return `⚠️ Nenhum erro corrigido. ${comparison.persistentErrors.length} erros persistem. Revise sua abordagem: você está corrigindo o arquivo correto? O patch está sendo aplicado nas linhas exatas do erro?`;
    }

    // Progresso parcial
    if (comparison.resolvedErrors.length > 0 && comparison.persistentErrors.length > 0) {
      return `✅ Progresso: ${comparison.resolvedErrors.length} erros corrigidos! Agora foque nos ${comparison.persistentErrors.length} restantes com a mesma abordagem bem-sucedida.`;
    }

    // Novos erros introduzidos
    if (comparison.newErrors.length > comparison.resolvedErrors.length) {
      return `⚠️ ${comparison.newErrors.length} novos erros introduzidos (${comparison.resolvedErrors.length} corrigidos). Reverta as alterações que causaram novos problemas e corrija apenas o necessário.`;
    }

    return null;
  }

  /**
   * Verifica se os arquivos mudaram desde a última validação.
   */
  filesChangedSinceLastValidation(files: Record<string, string>): boolean {
    if (this.validationHistory.length === 0) return true;

    const lastHash = this.validationHistory[this.validationHistory.length - 1].filesHash;
    const currentHash = this.hashFiles(files);

    return lastHash !== currentHash;
  }

  private hashFiles(files: Record<string, string>): string {
    return createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex");
  }

  /** Retorna estatísticas */
  getStats(): {
    totalValidations: number;
    lastErrorCount: number;
    isInLoop: boolean;
  } {
    const last = this.validationHistory[this.validationHistory.length - 1];
    return {
      totalValidations: this.validationHistory.length,
      lastErrorCount: last?.errors.length ?? 0,
      isInLoop: this.isInValidationLoop()
    };
  }

  /** Reseta histórico */
  reset(): void {
    this.validationHistory = [];
  }
}
