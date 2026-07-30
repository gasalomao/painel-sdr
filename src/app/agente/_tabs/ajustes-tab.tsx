"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";
import { Toggle } from "../_components/toggle";
import { SaveButton } from "../_components/save-button";

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
    <section className="border border-white/[0.08] bg-card/80 rounded-xl shadow-none space-y-6 p-6">
      <header className="flex items-center gap-3 border-b border-white/[0.06] pb-4">
        <div className="p-2.5 rounded-xl bg-primary/15 text-primary shrink-0">
          <Clock className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground">Horário de atendimento</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Escolha se a IA atende o dia todo ou só nos horários que você definir.
          </p>
        </div>
      </header>

      {/* Atendimento 24h */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Atender 24 horas por dia</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {is24h
              ? "A IA responde a qualquer hora, todos os dias."
              : "A IA só responde nos horários abaixo. Fora deles, envia a mensagem de ausência."}
          </p>
        </div>
        <Toggle
          checked={is24h}
          onCheckedChange={setIs24h}
          color="green"
          size="md"
          aria-label="Modo 24h"
        />
      </div>

      {/* Tabela de horários */}
      {!is24h && (
        <div className="space-y-2 border border-white/[0.06] rounded-xl overflow-hidden">
          <div className="grid grid-cols-12 gap-4 px-4 py-3 items-center border-b border-white/[0.06] bg-white/[0.02]">
            <div className="col-span-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Dia</div>
            <div className="col-span-8 grid grid-cols-[auto_1fr_1fr] gap-3 items-center">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground w-16">Ativo</span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Início</span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Fim</span>
            </div>
          </div>
          {schedules.map((row, idx) => (
            <div
              key={row.day}
              className="grid grid-cols-12 gap-4 px-4 py-3 items-center border-b border-white/[0.04] last:border-0"
            >
              <div className="col-span-4 text-sm font-medium text-foreground/90">{row.day}</div>
              <div className="col-span-8 grid grid-cols-[auto_1fr_1fr] gap-3 items-center">
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
                <Input
                  type="time"
                  disabled={!row.active}
                  className="bg-white/[0.02] border-white/[0.08] h-9 text-sm rounded-lg disabled:opacity-40"
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
                  className="bg-white/[0.02] border-white/[0.08] h-9 text-sm rounded-lg disabled:opacity-40"
                  value={row.end}
                  onChange={(e) => {
                    const ns = [...schedules];
                    ns[idx].end = e.target.value;
                    setSchedules(ns);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Mensagem de ausência */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label className="text-sm font-medium text-foreground">Mensagem de ausência</label>
          {is24h && (
            <span className="text-xs text-muted-foreground">Não é usada no modo 24h</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {is24h
            ? "Esta mensagem não será enviada enquanto o modo 24h estiver ativo."
            : "Enviada automaticamente quando alguém manda mensagem fora dos horários ativos acima."}
        </p>
        <Textarea
          value={awayMessage}
          onChange={(e) => setAwayMessage(e.target.value)}
          placeholder="Ex: Olá! No momento estamos fora do horário de atendimento. Retornamos amanhã às 08:00."
          className="bg-white/[0.02] border-white/[0.08] rounded-lg h-24 text-sm"
        />
      </div>

      <SaveButton label="Salvar Configurações" onSave={onSave} disabled={saving} />
    </section>
  );
}