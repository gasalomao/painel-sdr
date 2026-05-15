"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type PreviewLead = {
  id: number;
  remoteJid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  categoria: string | null;
  endereco: string | null;
  website: string | null;
  telefone: string | null;
};

export type PreviewSample = {
  nome_negocio: string;
  ramo_negocio: string;
  push_name: string;
  telefone: string;
  endereco: string;
  categoria: string;
  website: string;
};

export function LeadSelectorUI({
  sample,
  setSample,
  leads,
  leadsLoading,
  selectedLeadId,
  onSelectLead,
  leadQuery,
  setLeadQuery,
}: {
  sample: PreviewSample;
  setSample: (s: PreviewSample) => void;
  leads: PreviewLead[];
  leadsLoading: boolean;
  selectedLeadId: number | null;
  onSelectLead: (lead: PreviewLead) => void;
  leadQuery: string;
  setLeadQuery: (v: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const filteredLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    if (!q) return leads.slice(0, 50);
    return leads
      .filter((l) =>
        (l.nome_negocio || "").toLowerCase().includes(q) ||
        (l.telefone || "").toLowerCase().includes(q) ||
        (l.remoteJid || "").toLowerCase().includes(q) ||
        (l.categoria || "").toLowerCase().includes(q) ||
        (l.ramo_negocio || "").toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [leads, leadQuery]);

  const selectedLead = leads.find((l) => l.id === selectedLeadId) || null;

  const fields: Array<[keyof PreviewSample, string]> = [
    ["nome_negocio", "Nome empresa"],
    ["ramo_negocio", "Ramo"],
    ["push_name", "Nome WhatsApp"],
    ["telefone", "Telefone"],
    ["categoria", "Categoria"],
    ["endereco", "Endereço"],
    ["website", "Website"],
  ];

  return (
    <div className="rounded-xl bg-black/30 border border-white/5 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300">Simular com qual lead?</p>
        {selectedLead && (
          <span className="text-[10px] text-emerald-300 font-mono">
            ✓ usando: {selectedLead.nome_negocio || selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}
          </span>
        )}
      </div>

      {/* Picker dropdown */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 hover:border-cyan-500/40 transition text-left"
        >
          <span className="text-[12px] text-white truncate">
            {selectedLead ? (
              <>
                <span className="font-bold">{selectedLead.nome_negocio || "(sem nome)"}</span>
                <span className="text-muted-foreground ml-2 text-[10px]">{selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}</span>
                {selectedLead.ramo_negocio && <span className="text-muted-foreground ml-2 text-[10px]">· {selectedLead.ramo_negocio}</span>}
              </>
            ) : (
              <span className="text-muted-foreground italic">Clique pra escolher um lead da sua base… ({leads.length} disponíveis)</span>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">{pickerOpen ? "▲" : "▼"}</span>
        </button>

        {pickerOpen && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-[#0a0a0a] border border-cyan-500/20 shadow-2xl overflow-hidden">
            <div className="p-2 border-b border-white/5">
              <input
                autoFocus
                value={leadQuery}
                onChange={(e) => setLeadQuery(e.target.value)}
                placeholder="Buscar por nome, telefone, ramo, categoria..."
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-1.5 text-[12px] text-white focus:border-cyan-500/50 outline-none"
              />
            </div>
            <div className="max-h-72 overflow-y-auto custom-scrollbar">
              {leadsLoading ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">Carregando leads...</div>
              ) : filteredLeads.length === 0 ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">
                  {leads.length === 0 ? "Nenhum lead cadastrado em leads_extraidos." : "Nenhum lead bate com a busca."}
                </div>
              ) : (
                filteredLeads.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      onSelectLead(l);
                      setPickerOpen(false);
                      setLeadQuery("");
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-cyan-500/10 transition border-b border-white/[0.03] last:border-0",
                      selectedLeadId === l.id && "bg-cyan-500/10"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-bold text-white truncate">
                          {l.nome_negocio || <span className="italic text-muted-foreground">(sem nome)</span>}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                          {l.telefone || (l.remoteJid || "").replace(/@.*$/, "")}
                          {l.ramo_negocio && <span className="ml-2">· {l.ramo_negocio}</span>}
                          {l.categoria && <span className="ml-2">· {l.categoria}</span>}
                        </p>
                      </div>
                      {selectedLeadId === l.id && <span className="text-cyan-300 text-[10px] font-bold shrink-0">✓ atual</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
            {leads.length > filteredLeads.length && (
              <div className="p-2 text-[9px] text-muted-foreground text-center border-t border-white/5">
                Mostrando {filteredLeads.length} de {leads.length}. Refine a busca pra ver mais.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Editable fields grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-white/5">
        {fields.map(([k, label]) => (
          <div key={k}>
            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-black">{label}</label>
            <input
              value={sample[k] || ""}
              onChange={(e) => setSample({ ...sample, [k]: e.target.value })}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] font-mono text-white focus:border-cyan-500/50 outline-none"
            />
          </div>
        ))}
      </div>
      <p className="text-[9px] text-muted-foreground italic">
        Os campos são preenchidos automaticamente ao escolher um lead. Você ainda pode editar manualmente pra simular cenários hipotéticos.
      </p>
    </div>
  );
}
