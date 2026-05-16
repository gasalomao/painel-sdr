"use client";

import { useEffect, useState, useCallback } from "react";

export interface SessionInfo {
  authenticated: boolean;
  clientId: string | null;
  actorId?: string;
  name?: string;
  email?: string;
  isAdmin?: boolean;
  impersonating?: boolean;
  features?: Record<string, boolean>;
}

/**
 * Hook para pegar o clientId da sessão atual.
 * Cacheado em memória dentro do mesmo ciclo de vida do componente.
 * Dispara re-fetch quando o evento "session-changed" é emitido.
 */
export function useClientSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/session", { cache: "no-store" });
      const d = await r.json();
      setSession(d as SessionInfo);
    } catch {
      setSession({ authenticated: false, clientId: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("session-changed", handler);
    return () => window.removeEventListener("session-changed", handler);
  }, [load]);

  return { session, loading, clientId: session?.clientId || null };
}

/**
 * Função standalone para pegar o clientId da sessão atual.
 * Útil em callbacks e event handlers onde hooks não podem ser usados.
 */
export async function getClientId(): Promise<string | null> {
  try {
    const r = await fetch("/api/auth/session", { cache: "no-store" });
    const d = await r.json();
    return d?.clientId || null;
  } catch {
    return null;
  }
}
