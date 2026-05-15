"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";
import { Toggle } from "../_components/toggle";

export type ScheduleRow = { day: string; active: boolean; start: string; end: string };

export function AjustesTab({
  is24h,
  setIs24h,
  schedules,
  setSchedules,
  awayMessage,
  setAwayMessage,
  onSave,
  saving,
}: {
  is24h: boolean;
  setIs24h: (v: boolean) => void;
  schedules: ScheduleRow[];
  setSchedules: (v: ScheduleRow[]) => void;
  awayMessage: string;
  setAwayMessage: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <section className="glass-card p-8 rounded-[2rem] border-white/10 space-y-6 bg-white/[0.02]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/10 pb-6 mb-6">
        <div className="p-3 bg-primary/20 text-primary rounded-xl shrink-0">
          <Clock className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-lg font-black tracking-tight">Modo de atendimento</h3>
          <p className="text-xs text-muted-foreground mt-1">Defina quando a IA deve responder.</p>
        </div>
      </div>

      {/* Toggle 24h vs comercial */}
      <div className="flex items-center justify-between border-b border-white/5 pb-4">
        <div className="flex items-center gap-3 bg-white/5 px-4 py-2 rounded-2xl border border-white/5 hover:border-white/10 transition-all">
          <div className={cn("w-2 h-2 rounded-full", is24h ? "bg-green-500" : "bg-red-500")} />
          <span className={cn("text-[10px] font-black uppercase tracking-widest", is24h ? "text-green-500" : "text-red-500")}>
            {is24h ? "Ativado 24h" : "Horário Comercial"}
          </span>
          <Toggle
            checked={is24h}
            onCheckedChange={setIs24h}
            color="green"
            size="md"
            aria-label="Modo 24h"
          />
        </div>
      </div>

      {/* Tabela de horários (só aparece se NÃO for 24h) */}
      {!is24h && (
        <div className="space-y-2 border border-white/10 rounded-[1.5rem] bg-black/20 overflow-hidden">
          {schedules.map((row, idx) => (
            <div key={row.day} className="grid grid-cols-12 gap-4 px-6 py-4 items-center border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors">
              <div className="col-span-4 font-bold text-sm text-white/90">{row.day}</div>
              <div className="col-span-8 flex items-center gap-6">
                <Toggle
                  checked={row.active}
                  onCheckedChange={(next) => {
                    const ns = [...schedules];
                    ns[idx].active = next;
                    setSchedules(ns);
                  }}
                  color="green"
                  size="md"
                  aria-label={`Ativar ${row.day}`}
                />
                <div className="flex-1 flex gap-2">
                  <Input
                    type="time"
                    disabled={!row.active}
                    className="bg-white/5 border-white/10 h-10 w-full text-sm rounded-xl focus:bg-white/10"
                    value={row.start}
                    onChange={(e) => {
                      const ns = [...schedules];
                      ns[idx].start = e.target.value;
                      setSchedules(ns);
                    }}
                  />
                  <Input
                    type="time"
                    disabled={!row.active}
                    className="bg-white/5 border-white/10 h-10 w-full text-sm rounded-xl focus:bg-white/10"
                    value={row.end}
                    onChange={(e) => {
                      const ns = [...schedules];
                      ns[idx].end = e.target.value;
                      setSchedules(ns);
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Mensagem de ausência */}
      <div className="mt-6 space-y-2 text-xs">
        <label className="text-[10px] font-black uppercase tracking-widest text-primary">Mensagem de Ausência</label>
        <Textarea value={awayMessage} onChange={(e) => setAwayMessage(e.target.value)} className="bg-black/40 border-white/10 rounded-2xl h-24 text-sm" />
      </div>

      <Button onClick={onSave} disabled={saving} className="w-full h-11 rounded-xl bg-primary text-black font-bold">
        Salvar Configurações
      </Button>
    </section>
  );
}
