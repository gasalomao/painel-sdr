"use client";

import { useEffect, useMemo } from "react";
import { renderTemplate } from "@/lib/template-vars";
import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";
import { LeadSelectorUI, type PreviewLead, type PreviewSample } from "./lead-selector";

/* ========================================================
   PromptPreview — mostra como o prompt fica DEPOIS das
   substituições, do jeito que a IA recebe.
   - Resolve {{vars}} usando o sample do lead.
   - Expande {{kb:Título}} no mesmo texto que o backend injeta.
   - Destaca em verde tudo que foi resolvido e em vermelho o
     que ficou sem valor (var inexistente).
======================================================== */

type Knowledge = { id: string; title: string; content?: string };

function buildSampleCtx(sample: PreviewSample) {
  return {
    remoteJid: sample.telefone ? `${sample.telefone}@s.whatsapp.net` : undefined,
    nome_negocio: sample.nome_negocio || null,
    ramo_negocio: sample.ramo_negocio || null,
    push_name: sample.push_name || null,
    telefone: sample.telefone || null,
    endereco: sample.endereco || null,
    categoria: sample.categoria || null,
    website: sample.website || null,
  };
}

// Mesmo texto que o backend injeta em /api/agent/process pra cada KB referenciada.
function kbInjection(title: string) {
  return `Quando o cliente perguntar sobre **${title}** (ou tópico relacionado), VOCÊ DEVE chamar a tool \`search_knowledge_base\` com query="${title}" ANTES de responder. Não invente — sempre consulte.`;
}

export function PromptPreview({
  rawPrompt,
  sample,
  setSample,
  knowledge,
  open,
  leads,
  leadsLoading,
  onOpenLeadPicker,
  selectedLeadId,
  onSelectLead,
  leadQuery,
  setLeadQuery,
}: {
  rawPrompt: string;
  sample: PreviewSample;
  setSample: (s: PreviewSample) => void;
  knowledge: Knowledge[];
  open: boolean;
  setOpen: (v: boolean) => void;
  leads: PreviewLead[];
  leadsLoading: boolean;
  onOpenLeadPicker: () => void;
  selectedLeadId: number | null;
  onSelectLead: (lead: PreviewLead) => void;
  leadQuery: string;
  setLeadQuery: (v: string) => void;
}) {
  // Carrega leads ao abrir a pré-visualização pela primeira vez
  useEffect(() => {
    if (open) onOpenLeadPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Extrai vars usadas (incluindo kb:) — pra UI mostrar contadores
  const used = useMemo(() => {
    const set = new Set<string>();
    const kbs = new Set<string>();
    const re = /\{\{\s*(kb:)?([a-z_][\w]*|[^}]+?)\s*\}\}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawPrompt))) {
      if (m[1]) kbs.add(m[2].trim()); else set.add(m[2].trim().toLowerCase());
    }
    return { vars: Array.from(set), kbs: Array.from(kbs) };
  }, [rawPrompt]);

  // Expande {{kb:Título}} pro mesmo texto que o backend usa
  const expandedKb = useMemo(() => {
    return rawPrompt.replace(/\{\{kb:([^}]+)\}\}/g, (_match, rawTitle) => {
      const title = String(rawTitle).trim();
      const exists = knowledge.find((k) => k.title?.toLowerCase() === title.toLowerCase());
      return exists ? kbInjection(exists.title) : `__KBMISSING:${title}__`;
    });
  }, [rawPrompt, knowledge]);

  // Resolve as variáveis dinâmicas com o sample
  const rendered = useMemo(() => renderTemplate(expandedKb, buildSampleCtx(sample)), [expandedKb, sample]);

  // Constrói segmentos com kind pra colorir cada parte
  const segments = useMemo(() => {
    type Seg = { kind: "text" | "missing-var" | "missing-kb" | "kb" | "var"; text: string; original?: string };
    const parts: Seg[] = [];
    const ctx = buildSampleCtx(sample);
    const re = /\{\{\s*(kb:)?([^}]+?)\s*\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawPrompt))) {
      if (m.index > last) parts.push({ kind: "text", text: rawPrompt.slice(last, m.index) });
      const isKb = !!m[1];
      const key = m[2].trim();
      if (isKb) {
        const exists = knowledge.find((k) => k.title?.toLowerCase() === key.toLowerCase());
        if (exists) {
          parts.push({ kind: "kb", text: kbInjection(exists.title), original: key });
        } else {
          parts.push({ kind: "missing-kb", text: key, original: key });
        }
      } else {
        const resolvedVal = renderTemplate(`{{${key}}}`, ctx);
        if (resolvedVal === `{{${key}}}` || resolvedVal === "" || resolvedVal == null) {
          parts.push({ kind: "missing-var", text: m[0], original: key });
        } else {
          parts.push({ kind: "var", text: resolvedVal, original: key });
        }
      }
      last = m.index + m[0].length;
    }
    if (last < rawPrompt.length) parts.push({ kind: "text", text: rawPrompt.slice(last) });
    return parts;
  }, [rawPrompt, sample, knowledge]);

  const missingVars = segments.filter((s) => s.kind === "missing-var").length;
  const missingKbs = segments.filter((s) => s.kind === "missing-kb").length;
  const charDiff = rendered.length - rawPrompt.length;

  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent overflow-hidden">
      {/* Header com contadores */}
      <div className="w-full flex items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-widest text-emerald-300">
              Pré-visualização — como a IA vai receber
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {used.vars.length} variável{used.vars.length !== 1 ? "is" : ""} dinâmica{used.vars.length !== 1 ? "s" : ""} ·{" "}
              {used.kbs.length} ref. KB · {rendered.length.toLocaleString("pt-BR")} caracteres
              {charDiff !== 0 && <span className="text-emerald-400/70"> ({charDiff > 0 ? "+" : ""}{charDiff} vs prompt cru)</span>}
              {missingVars > 0 && <span className="text-red-400 ml-2">⚠ {missingVars} variável{missingVars !== 1 ? "is" : ""} sem valor</span>}
              {missingKbs > 0 && <span className="text-red-400 ml-2">⚠ {missingKbs} KB inexistente{missingKbs !== 1 ? "s" : ""}</span>}
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 p-4 space-y-4">
        <LeadSelectorUI
          sample={sample}
          setSample={setSample}
          leads={leads}
          leadsLoading={leadsLoading}
          selectedLeadId={selectedLeadId}
          onSelectLead={onSelectLead}
          leadQuery={leadQuery}
          setLeadQuery={setLeadQuery}
        />

        {/* Render visual com highlight por tipo */}
        <div className="rounded-xl bg-[#050505] border border-white/10 p-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
          <pre className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            {segments.length === 0 ? (
              <span className="text-muted-foreground italic">Prompt vazio.</span>
            ) : segments.map((seg, i) => {
              if (seg.kind === "missing-var") {
                return (
                  <span key={i} className="bg-red-500/20 text-red-300 px-1 rounded border border-red-500/40" title="Esta variável não tem valor — vai aparecer literalmente assim no prompt da IA">
                    {seg.text}
                  </span>
                );
              }
              if (seg.kind === "missing-kb") {
                return (
                  <span key={i} className="bg-red-500/20 text-red-300 px-1 rounded border border-red-500/40" title="Esta KB não existe">
                    [KB &quot;{seg.text}&quot; não encontrada]
                  </span>
                );
              }
              if (seg.kind === "var") {
                return (
                  <span
                    key={i}
                    className="px-0.5 rounded font-semibold text-yellow-200 underline decoration-emerald-400 decoration-2 underline-offset-[3px]"
                    title={`Variável dinâmica {{${seg.original}}} resolvida para: "${seg.text}"`}
                  >
                    {seg.text}
                  </span>
                );
              }
              if (seg.kind === "kb") {
                return (
                  <span
                    key={i}
                    className="bg-purple-500/15 text-fuchsia-100 px-1 rounded border border-purple-500/30 underline decoration-emerald-400 decoration-2 underline-offset-[3px]"
                    title={`Variável de conhecimento {{kb:${seg.original}}} expandida`}
                  >
                    {seg.text}
                  </span>
                );
              }
              return <span key={i} className="text-white/85">{seg.text}</span>;
            })}
          </pre>
        </div>

        {/* Legenda */}
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="font-semibold text-yellow-200 underline decoration-emerald-400 decoration-2 underline-offset-[3px] px-0.5">valor</span>
            <span>variável dinâmica resolvida</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-purple-500/15 text-fuchsia-100 px-1 rounded border border-purple-500/30 underline decoration-emerald-400 decoration-2 underline-offset-[3px]">regra</span>
            <span>KB expandida</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded bg-red-500/20 border border-red-500/40" /> variável/KB sem valor — vai aparecer literal
          </span>
        </div>

        {/* Variáveis usadas */}
        {used.vars.length > 0 && (
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300 mb-1">Variáveis dinâmicas detectadas</p>
            <div className="flex flex-wrap gap-1.5">
              {used.vars.map((v) => {
                const ctx = buildSampleCtx(sample);
                const resolvedVal = renderTemplate(`{{${v}}}`, ctx);
                const isUnresolved = resolvedVal === `{{${v}}}`;
                return (
                  <span
                    key={v}
                    className={cn(
                      "px-2 py-0.5 rounded font-mono text-[10px] border",
                      isUnresolved
                        ? "bg-red-500/10 border-red-500/30 text-red-300"
                        : "bg-cyan-500/10 border-cyan-500/30 text-cyan-200"
                    )}
                    title={isUnresolved ? "Variável sem valor no sample" : `Será substituída por: "${resolvedVal}"`}
                  >
                    {`{{${v}}}`} {!isUnresolved && <span className="opacity-70">→ {resolvedVal.slice(0, 40)}{resolvedVal.length > 40 ? "…" : ""}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* KBs referenciadas */}
        {used.kbs.length > 0 && (
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-1">Bases de conhecimento referenciadas</p>
            <div className="flex flex-wrap gap-1.5">
              {used.kbs.map((t) => {
                const exists = knowledge.find((k) => k.title?.toLowerCase() === t.toLowerCase());
                return (
                  <span
                    key={t}
                    className={cn(
                      "px-2 py-0.5 rounded font-mono text-[10px] border",
                      exists
                        ? "bg-purple-500/10 border-purple-500/30 text-purple-200"
                        : "bg-red-500/10 border-red-500/30 text-red-300"
                    )}
                    title={exists ? "KB encontrada — IA vai consultar via tool" : "KB não cadastrada"}
                  >
                    {`{{kb:${t}}}`} {!exists && "⚠"}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
