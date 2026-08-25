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
 * Fetch de sessão com cache de PROMISE em nível de módulo: header, sidebar e
 * página montam ao mesmo tempo e cada um chamava /api/auth/session — 3
 * round-trips idênticos por navegação. Com o cache, os 3 esperam a MESMA
 * promessa (1 round-trip). "session-changed" invalida pra re-buscar.
 */
let sessionPromise: Promise<SessionInfo> | null = null;

function fetchSession(): Promise<SessionInfo> {
  if (!sessionPromise) {
    sessionPromise = fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .catch((e) => {
        // Falha NÃO fica cacheada — próxima chamada tenta de novo.
        // Sem isso, um blip de rede ou login em SPA travava todos os
        // consumidores com authenticated:false até F5.
        sessionPromise = null;
        throw e;
      });
  }
  return sessionPromise;
}

/**
 * Hook para pegar o clientId da sessão atual.
 * Dispara re-fetch quando o evento "session-changed" é emitido.
 */
export function useClientSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await fetchSession();
      setSession(d as SessionInfo);
    } catch {
      setSession({ authenticated: false, clientId: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const handler = () => {
      sessionPromise = null; // invalida — próxima leitura busca de novo
      load();
    };
    window.addEventListener("session-changed", handler);
    return () => window.removeEventListener("session-changed", handler);
  }, [load]);

  return { session, loading, clientId: session?.clientId || null };
}
