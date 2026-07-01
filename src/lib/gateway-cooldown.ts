/**
 * Cooldown de GATEWAY de assinatura entre contas — em MEMÓRIA (não persiste).
 *
 * POR QUE EXISTE: quando uma conta conectada (endpoint) esgota o uso grátis
 * (429/quota) ou a credencial morre (401/403), o roteador de IA deve pular ela
 * e tentar OUTRA conta conectada. Este módulo diz "esta conta está descansando,
 * pule por enquanto" — exatamente o que `deepseek-chat-manager` faz pra tokens
 * DeepSeek, agora portado pro lado gateway.
 *
 * POR QUE EM MEMÓRIA (não banco): um restart do painel deve RETENTAR as contas
 * (o cooldown já pode ter passado, ou o problema era efêmero). Persistir criaria
 * o risco de uma conta ficar marcada pra sempre. Em memória, cada restart é uma
 * folha em branco — comportamento correto pra quota que reseta com o tempo.
 *
 * Server-only (estado de processo). No deploy single-instance (Easypanel) isso
 * é suficiente; multi-instância poderia divergir, mas o custo de divergir é só
 * "tentar uma conta que talvez ainda esteja em cooldown" — não-fatal.
 *
 * Semântica (igual ao DeepSeek):
 *   - 429 / quota  → cooldown TEMPORÁRIO (volta sozinho depois do prazo).
 *   - 401 / 403    → marcado MORTO (pula sempre até restart — credencial inválida).
 *   - 5xx / rede   → NÃO marca aqui (transitório; o failover tenta outra conta
 *                    sem penalizar esta permanentemente — a próxima msg retenta).
 */

/** Cooldown temporário: endpointId → timestamp (ms) até quando pular. */
const COOLDOWN = new Map<string, number>();
/** Endpoint "morto": credencial inválida (401/403). Pula até restart. */
const DEAD = new Set<string>();

/** Cooldown padrão pós-429 (recuo). Sobrescrevível p/ testes/flexibilidade. */
const DEFAULT_429_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

/**
 * Marca um endpoint em cooldown TEMPORÁRIO (usar após 429/quota). Recuo
 * exponencial leve: se já estava em cooldown, dobra o prazo (cap em 1h).
 */
export function markEndpointCooldown(id: string, ms: number = DEFAULT_429_COOLDOWN_MS): void {
  if (!id) return;
  const now = Date.now();
  const current = COOLDOWN.get(id);
  // Recuo: se ainda está em cooldown, estende (até 60min).
  if (current && current > now) {
    const extended = Math.min(60 * 60 * 1000, (current - now) * 2 + now + ms);
    COOLDOWN.set(id, extended);
  } else {
    COOLDOWN.set(id, now + ms);
  }
}

/** Marca um endpoint como MORTO (401/403 — credencial inválida). Pula até restart. */
export function markEndpointDead(id: string): void {
  if (id) DEAD.add(id);
}

/** Verdadeiro se o endpoint NÃO deve ser tentado agora (cooldown OU morto). */
export function isEndpointUnavailable(id: string): boolean {
  if (!id) return false;
  if (DEAD.has(id)) return true;
  const until = COOLDOWN.get(id);
  if (!until) return false;
  if (Date.now() >= until) { COOLDOWN.delete(id); return false; } // expirou → libera
  return true;
}

/** Verdadeiro só se está em cooldown temporário (não morto). */
export function isEndpointCooling(id: string): boolean {
  if (!id || DEAD.has(id)) return false;
  const until = COOLDOWN.get(id);
  if (!until) return false;
  if (Date.now() >= until) { COOLDOWN.delete(id); return false; }
  return true;
}

/** Verdadeiro se está marcado como morto (401/403). */
export function isEndpointDead(id: string): boolean {
  return !!id && DEAD.has(id);
}

/** Limpa todo o estado (testes / reset manual). */
export function resetGatewayCooldown(): void {
  COOLDOWN.clear();
  DEAD.clear();
}
