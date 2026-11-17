"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert, Activity } from "lucide-react";

interface HealthCheck {
  id: string;
  title: string;
  status: "ok" | "warn" | "error";
  summary: string;
  actionHint?: string;
}

interface HealthResponse {
  success?: boolean;
  overall?: "ok" | "warn" | "error";
  checkedAt?: string;
  checks?: HealthCheck[];
}

export function SystemHealthPanel() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/system/health", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as HealthResponse | null;
      if (json && Array.isArray(json.checks)) {
        setData(json);
      }
    } catch {
      // Silencioso para não quebrar a tela de configurações caso offline
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  if (!data || !Array.isArray(data.checks)) {
    return null;
  }

  const overallBadge =
    data.overall === "ok"
      ? { label: "Tudo funcionando", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" }
      : data.overall === "warn"
        ? { label: "Atenção recomendada", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" }
        : { label: "Ação necessária", cls: "bg-red-500/15 text-red-300 border-red-500/30" };

  return (
    <Card className="border-white/10 bg-white/[0.02] shadow-md">
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 border border-emerald-500/20">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-sm font-bold uppercase tracking-wider">
              Saúde do Sistema
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Diagnóstico rápido de WhatsApp, IA, Google Agenda e banco de dados.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${overallBadge.cls}`}>
            {overallBadge.label}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadHealth()}
            disabled={loading}
            className="h-8 text-xs border-white/15 bg-white/5 hover:bg-white/10"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Revalidar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
        {data.checks.map((item) => {
          const icon =
            item.status === "ok" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : item.status === "warn" ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            );
          const borderCls =
            item.status === "ok"
              ? "border-emerald-500/20 bg-emerald-500/[0.03]"
              : item.status === "warn"
                ? "border-amber-500/25 bg-amber-500/[0.04]"
                : "border-red-500/30 bg-red-500/[0.05]";

          return (
            <div key={item.id} className={`rounded-xl border p-3 flex items-start gap-2.5 ${borderCls}`}>
              {icon}
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground leading-snug">{item.summary}</p>
                {item.actionHint && (
                  <p className="text-[11px] text-amber-300/90 leading-snug">{item.actionHint}</p>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

