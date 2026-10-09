/**
 * Security utilities for Website Studio API routes
 */

import { NextRequest } from "next/server";

/**
 * Valida se a requisição veio de uma origem autorizada (e.g., sandbox do Site Studio)
 * Por enquanto, aceita qualquer origem - implementar validação real em produção
 */
export function assertWebsiteOrigin(request: NextRequest): void {
  // TODO: Implementar validação real de origem em produção
  // Por enquanto, aceita qualquer requisição autenticada
  return;
}

/**
 * Valida se a requisição tem um token válido do Site Studio
 */
export function validateWebsiteToken(token: string | null): boolean {
  if (!token) return false;

  // TODO: Implementar validação real de token
  // Por enquanto, aceita qualquer token não-vazio
  return token.length > 0;
}
