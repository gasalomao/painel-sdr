"use client";

import { Check, Sparkles, Wrench } from "lucide-react";

const EVENTS = [
  { name: "MESSAGES_UPSERT", why: "Chega msg nova → IA responde" },
  { name: "MESSAGES_UPDATE", why: "Status entregue/lido" },
  { name: "MESSAGES_DELETE", why: "Msg apagada aparece no chat" },
  { name: "SEND_MESSAGE", why: "Rastrear o que o operador enviou" },
  { name: "CONNECTION_UPDATE", why: "Banner de reconectar no painel" },
];

function StepNumber({ n, color }: { n: number; color: "cyan" | "amber" | "purple" | "blue" }) {
  const palette = {
    cyan: "bg-[#00ffcc]/10 border-[#00ffcc]/30 text-[#00ffcc]",
    amber: "bg-amber-500/10 border-amber-500/30 text-amber-400",
    purple: "bg-purple-500/10 border-purple-500/30 text-purple-400",
    blue: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  };
  return (
    <div className={`w-7 h-7 rounded-full font-black text-xs flex items-center justify-center shrink-0 border ${palette[color]}`}>
      {n}
    </div>
  );
}

/**
 * Guia visual passo-a-passo de como configurar o webhook na Evolution API.
 * Mostrado abaixo do campo `webhookUrl` na aba Info — totalmente estático,
 * só serve de referência caso o usuário não use o botão "Sincronizar Agora".
 */
export function WebhookGuide({ webhookUrl }: { webhookUrl: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#00ffcc]/5 via-transparent to-purple-500/5 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/5 bg-black/30">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#00ffcc]/10 border border-[#00ffcc]/20">
            <Wrench className="w-4 h-4 text-[#00ffcc]" />
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-white">Como ligar o Webhook na Evolution API</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Passo a passo. Se clicar em <strong>Sincronizar Agora</strong> o sistema já faz tudo isso automaticamente — este guia é só caso queira conferir manualmente no painel.
            </p>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* 1 */}
        <div className="flex gap-3">
          <StepNumber n={1} color="cyan" />
          <div className="space-y-1">
            <p className="text-[11px] font-bold text-white">
              Abra sua instância no painel da Evolution e vá em <span className="text-[#00ffcc]">Webhook</span>
            </p>
            <p className="text-[10px] text-muted-foreground">
              Dentro de cada instância existe uma aba "Webhook". É lá que a gente cola a URL do painel.
            </p>
          </div>
        </div>

        {/* 2 — Enabled */}
        <div className="flex gap-3">
          <StepNumber n={2} color="cyan" />
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-white">
              Ative <span className="text-emerald-400">Enabled</span> (liga o webhook)
            </p>
            <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5">
              <span className="inline-block w-8 h-4 rounded-full bg-emerald-500/70 relative">
                <span className="absolute right-0.5 top-0.5 w-3 h-3 rounded-full bg-white" />
              </span>
              <span className="font-mono text-emerald-300">Webhook Enabled: ON</span>
            </div>
          </div>
        </div>

        {/* 3 — URL */}
        <div className="flex gap-3">
          <StepNumber n={3} color="cyan" />
          <div className="space-y-1.5 flex-1 min-w-0">
            <p className="text-[11px] font-bold text-white">Cole a URL exata que está no campo acima ⬆️</p>
            <div className="text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5 font-mono text-[#00ffcc] truncate">
              {webhookUrl}
            </div>
          </div>
        </div>

        {/* 4 — Webhook by Events */}
        <div className="flex gap-3">
          <StepNumber n={4} color="amber" />
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-white">
              Deixe <span className="text-red-400">Webhook by Events: OFF</span> — <span className="text-muted-foreground font-normal">IMPORTANTE</span>
            </p>
            <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-red-500/20">
              <span className="inline-block w-8 h-4 rounded-full bg-white/10 relative">
                <span className="absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-white/70" />
              </span>
              <span className="font-mono text-red-300">Webhook by Events: OFF</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Se ligar, a Evolution cria uma URL diferente pra cada evento (ex: /api/webhooks/whatsapp/messages-upsert) e o painel não consegue receber. Deixe OFF.
            </p>
          </div>
        </div>

        {/* 5 — Base64 */}
        <div className="flex gap-3">
          <StepNumber n={5} color="purple" />
          <div className="space-y-1.5">
            <p className="text-[11px] font-bold text-white">
              Ative <span className="text-emerald-400">Webhook Base64: ON</span> — <span className="text-muted-foreground font-normal">recomendado</span>
            </p>
            <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5">
              <span className="inline-block w-8 h-4 rounded-full bg-emerald-500/70 relative">
                <span className="absolute right-0.5 top-0.5 w-3 h-3 rounded-full bg-white" />
              </span>
              <span className="font-mono text-emerald-300">Webhook Base64: ON</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Envia imagens, áudios e documentos já decodificados no webhook. Sem isso, o painel precisa fazer uma segunda chamada pra baixar cada mídia (mais lento e pode falhar).
            </p>
          </div>
        </div>

        {/* 6 — Events */}
        <div className="flex gap-3">
          <StepNumber n={6} color="blue" />
          <div className="space-y-2 flex-1">
            <p className="text-[11px] font-bold text-white">
              Marque APENAS estes <span className="text-blue-400">5 eventos</span> (o resto deixe desmarcado)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {EVENTS.map((ev) => (
                <div key={ev.name} className="flex items-center gap-2 bg-black/30 rounded-lg px-2.5 py-1.5 border border-blue-500/10">
                  <span className="w-3 h-3 rounded border border-blue-500/60 bg-blue-500/20 flex items-center justify-center shrink-0">
                    <Check className="w-2 h-2 text-blue-300" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono text-blue-200 truncate">{ev.name}</p>
                    <p className="text-[9px] text-muted-foreground truncate">{ev.why}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground italic">
              Deixe <strong>desmarcados</strong>: CHATS_*, CONTACTS_*, GROUPS_*, LABELS_*, PRESENCE_UPDATE, QRCODE_UPDATED, TYPEBOT_*, CALL, APPLICATION_STARTUP, LOGOUT/REMOVE_INSTANCE. Se marcar esses o webhook recebe eventos demais e o sistema fica lento sem ganho.
            </p>
          </div>
        </div>

        {/* 7 — Salvar */}
        <div className="flex gap-3">
          <StepNumber n={7} color="cyan" />
          <div className="space-y-1">
            <p className="text-[11px] font-bold text-white">
              Clique em <span className="text-emerald-400">Save</span> na Evolution
            </p>
            <p className="text-[10px] text-muted-foreground">
              Pronto. A Evolution agora vai mandar cada mensagem recebida pra este painel em tempo real. Pode testar enviando uma mensagem pro WhatsApp dessa instância.
            </p>
          </div>
        </div>

        {/* Atalho */}
        <div className="mt-3 p-3 rounded-xl bg-[#00ffcc]/5 border border-[#00ffcc]/20 flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-[#00ffcc] shrink-0 mt-0.5" />
          <p className="text-[10px] text-[#00ffcc]/90 leading-relaxed">
            <strong className="text-[#00ffcc]">Atalho:</strong> clique em <strong>Sincronizar Agora</strong> acima. O painel chama a API da Evolution e configura tudo (URL, Events, Base64) automaticamente. Só use este guia se quiser conferir manualmente.
          </p>
        </div>
      </div>
    </div>
  );
}
