"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BackupDiagnosticReport } from "@/lib/backup-diagnostics";

interface DiagnosticResponse {
  success: boolean;
  error?: string;
  diagnostic?: BackupDiagnosticReport;
  diagnostics?: BackupDiagnosticReport[];
}

const statusLabel = { running: "Sem conclusão registrada", success: "Aprovado", failed: "Falhou", warning: "Com pendências" };

async function requestDiagnostics(method: "GET" | "POST", signal: AbortSignal): Promise<DiagnosticResponse> {
  const response = await fetch("/api/backup/diagnostics", {
    method, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
  });
  let data: DiagnosticResponse;
  try { data = await response.json() as DiagnosticResponse; }
  catch { throw new Error(`O servidor não retornou o diagnóstico (HTTP ${response.status}). Tente novamente ou confira o deploy do SDR.`); }
  if (!response.ok || !data.success) throw new Error(data.error || `Não foi possível consultar o diagnóstico (HTTP ${response.status}).`);
  return data;
}

export function BackupDiagnosticsPanel({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
  const [reports, setReports] = useState<BackupDiagnosticReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void requestDiagnostics("GET", controller.signal).then(data => {
      if (!controller.signal.aborted) setReports(data.diagnostics || []);
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Não foi possível carregar os testes anteriores.");
    }).finally(() => { if (!controller.signal.aborted) setIsLoading(false); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);

  const test = async (): Promise<void> => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setIsTesting(true); setError(null);
    try {
      const data = await requestDiagnostics("POST", controller.signal);
      if (controller.signal.aborted) return;
      if (!data.diagnostic) throw new Error("O servidor não confirmou o registro do teste. Confira o deploy do SDR.");
      const report = data.diagnostic;
      setReports(previous => [report, ...previous.filter(item => item.id !== report.id)].slice(0, 20));
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
        ? "O teste excedeu 90 segundos. Não foi confirmado como aprovado. Recarregue a página para conferir o registro no servidor."
        : e instanceof Error && !(e instanceof TypeError) ? e.message : "Não foi possível acessar o servidor. Confira sua conexão e tente novamente.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setIsTesting(false);
    }
  };

  return (
    <section aria-label="Diagnósticos de conexão" className="space-y-4 rounded-lg border border-border p-4">
      <h3 className="font-semibold">Testes de ferramentas e configuração</h3>
      <p className="text-sm text-muted-foreground">Verifica a conexão PostgreSQL e a configuração do SDR. Não cria cópias, não envia arquivos e não altera a agenda.</p>
      <Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" disabled={disabled || isLoading || isTesting} aria-busy={isTesting} onClick={() => { void test(); }}>
        {isTesting && <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin motion-reduce:animate-none" />}
        {isTesting ? "Testando ferramentas e conexão…" : "Testar ferramentas e conexão remota"}
      </Button>
      {isTesting && <p role="status" className="text-sm">Teste em andamento. Nenhum backup será criado. Aguarde o resultado nesta área.</p>}
      {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
      {isLoading ? <p className="text-sm text-muted-foreground">Carregando testes anteriores…</p> : !reports.length && <p className="text-sm text-muted-foreground">Nenhum diagnóstico registrado. Testes não aparecem no histórico de arquivos de backup.</p>}
      <div aria-live="polite" className="space-y-3">
        {reports.map((report, index) => (
          <details key={report.id} open={index === 0} className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {new Date(report.created_at).toLocaleString("pt-BR")} · {statusLabel[report.status]}
            </summary>
            {report.status === "running" && <p className="mt-2 text-sm text-amber-300">Sem conclusão registrada: o teste pode estar em execução ou ter sido interrompido. Não equivale a um teste aprovado.</p>}
            <ul className="mt-3 space-y-2 text-sm">
              {report.checks.map((check, position) => (
                <li key={`${check.name}-${position}`} className="break-words">
                  <span className={check.status === "failed" ? "font-medium text-red-300" : check.status === "warning" ? "font-medium text-amber-300" : "font-medium text-emerald-300"}>
                    {check.status === "success" ? "OK" : check.status === "failed" ? "Falha" : "Atenção"} · {check.name}
                  </span>
                  <p>{check.message}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Diagnóstico não comprova que o banco selecionado é o correto, nem envio ao Drive ou restauração.</p>
          </details>
        ))}
      </div>
    </section>
  );
}
