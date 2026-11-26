"use client";

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Clock, Send, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type MentorRateBucket = {
  key: string;
  sent: number;
  responded: number;
  preview_accepted: number;
  preview_delivered: number;
  closed_won: number;
  taxa_resposta_1a_msg: number;
  taxa_aceite_previa: number;
  taxa_entrega_previa: number;
  taxa_fechamento: number;
};

type DeliveryItem = {
  id: string;
  remote_jid: string;
  instance_name: string;
  company_name?: string | null;
  preview_url: string;
  delivery_slot: string;
  scheduled_for: string;
  status: string;
};

export function MentorPreviewQueuePanel({
  instances,
}: {
  instances: string[];
}) {
  const [metrics, setMetrics] = useState<{
    overall: MentorRateBucket;
    by_instance: MentorRateBucket[];
    by_niche: MentorRateBucket[];
  } | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [remoteJid, setRemoteJid] = useState("");
  const [instanceName, setInstanceName] = useState(instances[0] || "");
  const [companyName, setCompanyName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [slot, setSlot] = useState<"now" | "plus_3h" | "evening_18h" | "next_morning_09h">("plus_3h");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!instanceName && instances.length > 0) setInstanceName(instances[0]);
  }, [instances, instanceName]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, qRes] = await Promise.all([
        fetch("/api/prospeccao-sites/mentor-metrics"),
        fetch("/api/prospeccao-sites/preview-queue"),
      ]);
      const mJson = await mRes.json().catch(() => null);
      const qJson = await qRes.json().catch(() => null);
      if (mJson?.ok && mJson.metrics) setMetrics(mJson.metrics);
      if (qJson?.ok && Array.isArray(qJson.deliveries)) setDeliveries(qJson.deliveries);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSchedule = async () => {
    if (!remoteJid.trim() || !instanceName.trim() || !previewUrl.trim()) {
      toast.error("Preencha WhatsApp do lead, chip e link da prévia.");
      return;
    }
    const cleanPhone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");
    const finalJid = cleanPhone.includes("@") ? cleanPhone : `${cleanPhone.startsWith("55") ? cleanPhone : `55${cleanPhone}`}@s.whatsapp.net`;

    setSubmitting(true);
    try {
      const res = await fetch("/api/prospeccao-sites/preview-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enqueue",
          remote_jid: finalJid,
          instance_name: instanceName,
          company_name: companyName.trim() || null,
          preview_url: previewUrl.trim(),
          delivery_slot: slot,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        toast.error(json?.error || "Falha ao agendar entrega");
        return;
      }
      toast.success(
        slot === "now"
          ? "Prévia enviada e IA mantida pausada para você assumir o X1!"
          : "Entrega natural da prévia agendada (IA continuará pausada para X1)!"
      );
      setRemoteJid("");
      setCompanyName("");
      setPreviewUrl("");
      void loadData();
    } catch {
      toast.error("Erro ao agendar prévia");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    const res = await fetch("/api/prospeccao-sites/preview-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", id }),
    });
    const json = await res.json().catch(() => null);
    if (json?.ok) {
      toast.success("Entrega cancelada");
      void loadData();
    }
  };

  const overall = metrics?.overall;

  return (
    <div className="space-y-5 mt-8">
      {/* 4 Taxas do Método Mentor */}
      <div className="rounded-xl border border-[#2a382e] bg-[#121814] p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-[#6ee7b7]" />
            <h3 className="text-sm font-semibold text-[#edf2ee]">
              Métricas do Funil — Método Mentor (4 Taxas)
            </h3>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="h-8 px-2.5 rounded border border-[#2e3b31] bg-[#18201b] text-xs text-[#c4d4c9] hover:text-white flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Atualizar
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg border border-[#263229] bg-[#0e1310] p-3">
            <p className="text-[11px] text-[#8fa396]">1. Resposta à 1ª Msg</p>
            <p className="text-xl font-bold text-[#edf2ee] mt-0.5">
              {overall ? `${overall.taxa_resposta_1a_msg}%` : "—"}
            </p>
            <p className="text-[11px] text-[#738579]">
              {overall ? `${overall.responded}/${overall.sent} leads` : ""}
            </p>
          </div>
          <div className="rounded-lg border border-[#263229] bg-[#0e1310] p-3">
            <p className="text-[11px] text-[#8fa396]">2. Aceite de Prévia</p>
            <p className="text-xl font-bold text-[#fbbf24] mt-0.5">
              {overall ? `${overall.taxa_aceite_previa}%` : "—"}
            </p>
            <p className="text-[11px] text-[#738579]">
              {overall ? `${overall.preview_accepted}/${overall.responded} respostas` : ""}
            </p>
          </div>
          <div className="rounded-lg border border-[#263229] bg-[#0e1310] p-3">
            <p className="text-[11px] text-[#8fa396]">3. Entrega da Prévia</p>
            <p className="text-xl font-bold text-[#38bdf8] mt-0.5">
              {overall ? `${overall.taxa_entrega_previa}%` : "—"}
            </p>
            <p className="text-[11px] text-[#738579]">
              {overall ? `${overall.preview_delivered}/${overall.preview_accepted} aceites` : ""}
            </p>
          </div>
          <div className="rounded-lg border border-[#263229] bg-[#0e1310] p-3">
            <p className="text-[11px] text-[#8fa396]">4. Fechamento X1</p>
            <p className="text-xl font-bold text-[#6ee7b7] mt-0.5">
              {overall ? `${overall.taxa_fechamento}%` : "—"}
            </p>
            <p className="text-[11px] text-[#738579]">
              {overall ? `${overall.closed_won}/${overall.preview_delivered} entregues` : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Fila Manual de Entrega Natural de Prévias (X1 Humano) */}
      <div className="rounded-xl border border-[#2a382e] bg-[#121814] p-4 sm:p-5 space-y-4">
        <div className="flex items-start gap-2.5">
          <Clock className="w-4 h-4 text-[#6ee7b7] mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-[#edf2ee]">
              Fila de Entrega Natural de Prévias (IA pausada para X1 manual)
            </h3>
            <p className="text-xs text-[#8fa396] mt-0.5">
              Agende o envio do link da prévia no tempo certo (+3h, 18h ou manhã seguinte). Após entregar o link, a Sarah permanece pausada para você fechar no X1.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5">
          <input
            type="text"
            value={remoteJid}
            onChange={(e) => setRemoteJid(e.target.value)}
            placeholder="WhatsApp (ex: 11999998888)"
            className="h-9 rounded-lg border border-[#2e3b31] bg-[#0e1310] px-3 text-xs text-[#edf2ee]"
          />
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Nome da empresa"
            className="h-9 rounded-lg border border-[#2e3b31] bg-[#0e1310] px-3 text-xs text-[#edf2ee]"
          />
          <input
            type="url"
            value={previewUrl}
            onChange={(e) => setPreviewUrl(e.target.value)}
            placeholder="Link da prévia (https://...)"
            className="h-9 rounded-lg border border-[#2e3b31] bg-[#0e1310] px-3 text-xs text-[#edf2ee]"
          />
          <select
            value={instanceName}
            onChange={(e) => setInstanceName(e.target.value)}
            className="h-9 rounded-lg border border-[#2e3b31] bg-[#0e1310] px-2.5 text-xs text-[#edf2ee]"
          >
            {instances.map((inst) => (
              <option key={inst} value={inst}>
                {inst}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <select
              value={slot}
              onChange={(e) => setSlot(e.target.value as typeof slot)}
              className="flex-1 h-9 rounded-lg border border-[#2e3b31] bg-[#0e1310] px-2 text-xs text-[#edf2ee]"
            >
              <option value="now">Enviar agora</option>
              <option value="plus_3h">+3h (natural)</option>
              <option value="evening_18h">Hoje 18h</option>
              <option value="next_morning_09h">Amanhã 09h</option>
            </select>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleSchedule()}
              className="h-9 px-3 rounded-lg bg-[#243d30] border border-[#4e7c62] text-[#a5f3cf] text-xs font-medium hover:bg-[#2a4738] flex items-center gap-1 shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? "..." : "Agendar"}
            </button>
          </div>
        </div>

        {deliveries.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t border-[#232d25] max-h-44 overflow-y-auto">
            {deliveries.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[#263229] bg-[#0e1310] px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <span className="font-medium text-[#edf2ee]">
                    {d.company_name || d.remote_jid.replace(/@.*$/, "")}
                  </span>
                  <span className="ml-2 text-[11px] text-[#8fa396]">
                    via {d.instance_name} · {d.status} ·{" "}
                    {new Date(d.scheduled_for).toLocaleString("pt-BR")}
                  </span>
                </div>
                {d.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => void handleCancel(d.id)}
                    className="text-red-300 hover:text-red-200 p-1"
                    title="Cancelar entrega"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
