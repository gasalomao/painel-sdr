"use client";

import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, MessageSquare, MapPin, Smartphone, History, Bot, Zap, Cpu } from "lucide-react";
import { NgrokQuickConnect } from "@/components/ngrok-quick-connect";

const pageTitles: Record<string, { title: string; description: string; icon: React.ElementType }> = {
  "/": { title: "Dashboard", description: "Visão geral da operação", icon: LayoutDashboard },
  "/leads": { title: "Gestão de Leads", description: "CRM completo", icon: Users },
  "/chat": { title: "Atendimento", description: "Chat em tempo real", icon: MessageSquare },
  "/agente": { title: "Agente IA", description: "Configuração de comportamento e conhecimento", icon: Bot },
  "/captador": { title: "Captador Maps", description: "Extração Google Maps", icon: MapPin },
  "/whatsapp": { title: "WhatsApp", description: "Conexão e gerenciamento", icon: Smartphone },
  "/historico-ia": { title: "Histórico IA", description: "Logs e decisões da Inteligência Artificial", icon: History },
  "/disparo": { title: "Disparo em Massa", description: "Primeira mensagem automática com intervalo aleatório", icon: Zap },
  "/automacao": { title: "Automação", description: "Captação → disparo → follow-up no piloto automático", icon: Cpu },
};

export function Header() {
  const pathname = usePathname();
  const page = pageTitles[pathname] || pageTitles["/"];
  const Icon = page.icon;

  return (
    <header className="sticky top-0 z-40 border-b border-border glass px-3 py-2.5 md:px-6 md:py-4">
      <div className="flex items-center justify-between gap-2 md:gap-3">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="w-8 h-8 md:w-9 md:h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 md:w-[18px] md:h-[18px] text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm md:text-base font-semibold text-foreground truncate">{page.title}</h1>
            <p className="text-[10px] md:text-xs text-muted-foreground truncate hidden sm:block">{page.description}</p>
          </div>
        </div>
        <div className="shrink-0">
          <NgrokQuickConnect />
        </div>
      </div>
    </header>
  );
}
