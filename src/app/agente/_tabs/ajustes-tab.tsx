"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Clock, Users, Mic, ArrowUp, ArrowDown, X, Plus } from "lucide-react";
import { Toggle } from "../_components/toggle";
import { SaveButton } from "../_components/save-button";

export type ScheduleRow = { day: string; active: boolean; start: string; end: string };
export type TranscriptionMethod = "auto" | "whisper" | "gemini" | "openrouter" | "disabled";

const TRANSCRIPTION_OPTIONS: { value: TranscriptionMethod; label: string; desc: string }[] = [
  { value: "auto", label: "Automático", desc: "Whisper primeiro (grátis), depois seus modelos OpenRouter e Gemini se falhar" },
  { value: "whisper", label: "Whisper (VPS)", desc: "Local e grátis — não gasta tokens" },
  { value: "openrouter", label: "OpenRouter (Cloud)", desc: "Escolha os modelos e a ordem — se um falhar tenta o próximo" },
  { value: "gemini", label: "Gemini (Cloud)", desc: "Melhor qualidade — gasta tokens da API" },
  { value: "disabled", label: "Desativado", desc: "Não transcreve áudios" },
];

type AudioModel = { id: string; name: string; free: boolean };

/**
 * Seletor de modelos OpenRouter de transcrição de áudio COM ORDEM de fallback.
 * Aplica nos métodos "auto" E "openrouter". Salva sozinho (debounce 600ms) em
 * agent_settings.options.transcription_models via /api/agent/transcription-models.
 * Lista vazia = padrão grátis → pagos.
 */
function TranscriptionModelPicker({ agentId }: { agentId: number | null }) {
  const [all, setAll] = useState<AudioModel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guarda pra qual agente a ordem carregou — evita salvar lista do agente A no B durante troca. */
  const loadedForRef = useRef<number | null>(null);

  // Catálogo ao vivo do OpenRouter
  useEffect(() => {
    let alive = true;
    fetch("/api/openrouter-audio-models")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.success && Array.isArray(d.models)) setAll(d.models);
        else setListError(d?.error || "Falha ao listar modelos.");
      })
      .catch(() => alive && setListError("Falha ao listar modelos."));
    return () => { alive = false; };
  }, []);

  // Ordem salva do agente — reseta estado ANTES do fetch (troca de agente
  // não pode herdar a lista do anterior nem salvar nela).
  useEffect(() => {
    setOrderLoaded(false);
    setChosen([]);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!agentId) { loadedForRef.current = null; setOrderLoaded(true); return; }
    let alive = true;
    fetch(`/api/agent/transcription-models?agent_id=${agentId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setChosen(Array.isArray(d?.models) ? d.models : []);
        loadedForRef.current = agentId;
        setOrderLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        loadedForRef.current = agentId;
        setOrderLoaded(true);
      });
    return () => { alive = false; };
  }, [agentId]);

  const persist = (next: string[]) => {
    setChosen(next);
    if (!agentId || !orderLoaded || loadedForRef.current !== agentId) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/agent/transcription-models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, models: next }),
        });
        setSaveState(r.ok ? "saved" : "error");
      } catch {
        setSaveState("error");
      }
    }, 600);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= chosen.length) return;
    const next = [...chosen];
    [next[idx], next[j]] = [next[j], next[idx]];
    persist(next);
  };

  const nameOf = (id: string): string => all?.find((m) => m.id === id)?.name || id;
  const isFree = (id: string): boolean => !!all?.find((m) => m.id === id)?.free;

  if (listError) return <p className="text-xs text-red-400/80">{listError}</p>;
  if (!all) return <p className="text-xs text-muted-foreground">Carregando modelos OpenRouter...</p>;

  const freeCount = all.filter((m) => m.free).length;
  const available = all
    .filter((m) => !chosen.includes(m.id))
    .filter((m) => !search.trim() || `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {all.length} modelos aceitam áudio ({freeCount} grátis). A transcrição tenta na ordem abaixo; se um falhar,
        passa pro próximo. Válido nos modos <span className="text-primary">Automático</span> e{" "}
        <span className="text-primary">OpenRouter</span>.
      </p>
      {freeCount > 0 && (
        <p className="text-[11px] text-amber-300/70 leading-relaxed">
          ⚠ Regra da OpenRouter: <strong>áudio</strong> nos modelos grátis exige saldo mínimo de US$0,50 na conta
          (depósito único em openrouter.ai/credits). Sem saldo, os grátis respondem 402 e o sistema cai pro
          Whisper local / Gemini automaticamente — modelos bloqueados ficam cacheados e param de custar latência.
        </p>
      )}

      {/* Ordem escolhida */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Ordem de tentativa ({chosen.length})
          </p>
          <span className={cn(
            "text-[10px]",
            saveState === "saved" && "text-emerald-400",
            saveState === "saving" && "text-muted-foreground",
            saveState === "error" && "text-red-400",
          )}>
            {saveState === "saved" && "Salvo ✓"}
            {saveState === "saving" && "Salvando..."}
            {saveState === "error" && "Erro ao salvar"}
          </span>
        </div>
        {chosen.length === 0 ? (
          <p className="text-xs text-muted-foreground italic border border-dashed border-white/[0.08] rounded-lg p-3">
            Nenhum modelo escolhido — usa o padrão automático: grátis primeiro, depois pagos (máx 8).
          </p>
        ) : (
          chosen.map((id, i) => (
            <div key={id} className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5">
              <span className="text-[10px] font-black text-primary w-5">{i + 1}.</span>
              {isFree(id) && (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[9px] font-bold px-1.5 py-0.5">GRÁTIS</span>
              )}
              <span className="text-xs text-foreground truncate flex-1" title={id}>{nameOf(id)}</span>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-25" aria-label="Subir prioridade">
                <ArrowUp className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === chosen.length - 1}
                className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-25" aria-label="Baixar prioridade">
                <ArrowDown className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button type="button" onClick={() => persist(chosen.filter((c) => c !== id))}
                className="p-1 rounded hover:bg-red-500/15" aria-label="Remover">
                <X className="w-3.5 h-3.5 text-red-400/70" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Catálogo disponível */}
      <div className="space-y-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar modelo..."
          className="bg-white/[0.02] border-white/[0.08] h-8 text-xs rounded-lg"
        />
        <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
          {available.length === 0 && (
            <p className="text-xs text-muted-foreground italic p-2">Nenhum modelo restante{search ? " para essa busca" : ""}.</p>
          )}
          {available.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => persist([...chosen, m.id])}
              disabled={chosen.length >= 10}
              title={`Adicionar "${m.name}" ao final da ordem`}
              className="w-full flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:border-primary/40 disabled:opacity-40 px-2.5 py-1.5 text-left transition-colors"
            >
              {m.free && (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[9px] font-bold px-1.5 py-0.5 shrink-0">GRÁTIS</span>
              )}
              <span className="text-xs text-foreground/90 truncate flex-1">{m.name}</span>
              <Plus className="w-3.5 h-3.5 text-primary/60 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AjustesTab({
  is24h,
  setIs24h,
  schedules,
  setSchedules,
  awayMessage,
  setAwayMessage,
  disableGroups,
  setDisableGroups,
  transcriptionMethod,
  setTranscriptionMethod,
  agentId,
  onSave,
  saving,
}: {
  is24h: boolean;
  setIs24h: (v: boolean) => void;
  schedules: ScheduleRow[];
  setSchedules: (v: ScheduleRow[]) => void;
  awayMessage: string;
  setAwayMessage: (v: string) => void;
  disableGroups: boolean;
  setDisableGroups: (v: boolean) => void;
  transcriptionMethod: TranscriptionMethod;
  setTranscriptionMethod: (v: TranscriptionMethod) => void;
  /** Agente ativo — o seletor de modelos salva a ordem por agente. */
  agentId?: number | null;
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

      {/* ===== Grupos do WhatsApp ===== */}
      <div className="border-t border-white/[0.06] pt-6 space-y-4">
        <header className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/15 text-primary shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Grupos do WhatsApp</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Controle se a IA atende grupos conectados a este número.
            </p>
          </div>
        </header>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Atender grupos</p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {!disableGroups
                ? "A IA responde mensagens e transcreve áudios recebidos em grupos."
                : "A IA ignora grupos: não responde nem transcreve áudios — economiza tokens. As mensagens continuam salvas no painel."}
            </p>
          </div>
          <Toggle
            checked={!disableGroups}
            onCheckedChange={(v) => setDisableGroups(!v)}
            color="green"
            size="md"
            aria-label="Atender grupos"
          />
        </div>
      </div>

      {/* ===== Transcrição de Áudio ===== */}
      <div className="border-t border-white/[0.06] pt-6 space-y-4">
        <header className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/15 text-primary shrink-0">
            <Mic className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Transcrição de áudio</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Escolha como os áudios recebidos são transcritos.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TRANSCRIPTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTranscriptionMethod(opt.value)}
              className={cn(
                "text-left rounded-xl border p-4 transition-colors",
                transcriptionMethod === opt.value
                  ? "border-primary/50 bg-primary/10"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]",
              )}
            >
              <p className={cn(
                "text-sm font-medium",
                transcriptionMethod === opt.value ? "text-primary" : "text-foreground",
              )}>
                {opt.label}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{opt.desc}</p>
            </button>
          ))}
        </div>

        {(transcriptionMethod === "openrouter" || transcriptionMethod === "auto") && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <TranscriptionModelPicker agentId={agentId ?? null} />
          </div>
        )}
      </div>

      <SaveButton label="Salvar Configurações" onSave={onSave} disabled={saving} />
    </section>
  );
}