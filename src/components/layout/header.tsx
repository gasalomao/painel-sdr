"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Users, MessageSquare, MapPin, Smartphone, History,
  Bot, Zap, Cpu, LogOut, ArrowLeftRight, Loader2, Shield, ChevronDown,
} from "lucide-react";
import { NgrokQuickConnect } from "@/components/ngrok-quick-connect";
import { cn } from "@/lib/utils";

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

type Session = {
  authenticated: boolean;
  clientId?: string;
  name?: string;
  email?: string;
  isAdmin?: boolean;
  impersonating?: boolean;
};

export function Header() {
  const pathname = usePathname();
  const page = pageTitles[pathname] || pageTitles["/"];
  const Icon = page.icon;
  const [session, setSession] = useState<Session | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setSession(d))
      .catch(() => setSession({ authenticated: false }));
  }, [pathname]);

  // Fecha menu ao clicar fora
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-user-menu]")) setMenuOpen(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [menuOpen]);

  const handleStopImpersonate = async () => {
    setStopping(true);
    try {
      const r = await fetch("/api/admin/stop-impersonate", { method: "POST" });
      const d = await r.json();
      if (d.ok) {
        // Hard navigation pra resetar TODO estado de cliente (sidebar, dados em cache, etc)
        window.location.href = "/admin/clientes";
      } else {
        alert("Erro: " + (d.error || "falha ao sair"));
        setStopping(false);
      }
    } catch (e: any) {
      alert("Erro: " + e.message);
      setStopping(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  };

  const isImpersonating = !!session?.impersonating;

  return (
    <>
      {/* Banner de impersonation — fixo no topo, visível em todas as páginas
          enquanto o admin estiver navegando como cliente. */}
      {isImpersonating && (
        <div className="sticky top-0 z-50 bg-gradient-to-r from-amber-500/95 via-orange-500/95 to-amber-500/95 text-black px-4 py-2 flex items-center justify-between gap-3 shadow-lg border-b-2 border-amber-700/50">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowLeftRight className="w-4 h-4 shrink-0" />
            <span className="text-xs font-bold truncate">
              Modo apresentação · Você está vendo o painel como <strong>{session?.name}</strong>
            </span>
          </div>
          <button
            onClick={handleStopImpersonate}
            disabled={stopping}
            className={cn(
              "shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-black uppercase tracking-widest",
              "bg-black/80 text-amber-100 hover:bg-black active:scale-95 transition-all disabled:opacity-60"
            )}
          >
            {stopping ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> Saindo...</>
            ) : (
              <><LogOut className="w-3 h-3" /> Sair do modo apresentação</>
            )}
          </button>
        </div>
      )}

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

          <div className="flex items-center gap-2 shrink-0">
            <NgrokQuickConnect />

            {/* User menu — avatar + nome + dropdown com Logout */}
            {session?.authenticated && (
              <div className="relative" data-user-menu>
                <button
                  onClick={() => setMenuOpen(!menuOpen)}
                  className={cn(
                    "flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-colors",
                    "hover:bg-white/5 active:scale-[0.98]",
                    isImpersonating
                      ? "border-amber-500/40 bg-amber-500/10"
                      : session.isAdmin
                        ? "border-purple-500/30 bg-purple-500/10"
                        : "border-white/10 bg-white/5"
                  )}
                >
                  <div className={cn(
                    "w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-black",
                    session.isAdmin && !isImpersonating
                      ? "bg-purple-500/30 text-purple-200"
                      : isImpersonating
                        ? "bg-amber-500/30 text-amber-100"
                        : "bg-primary/20 text-primary"
                  )}>
                    {session.isAdmin && !isImpersonating ? <Shield className="w-3 h-3" /> : (session.name?.[0] || "?")}
                  </div>
                  <div className="hidden md:block text-left">
                    <p className="text-[11px] font-bold text-white leading-tight truncate max-w-[140px]">{session.name}</p>
                    <p className="text-[9px] text-muted-foreground leading-tight">
                      {isImpersonating ? "modo apresentação" : session.isAdmin ? "administrador" : "cliente"}
                    </p>
                  </div>
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                </button>

                {menuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-white/10 bg-neutral-950/95 backdrop-blur-xl shadow-2xl overflow-hidden">
                    <div className="px-3 py-2.5 border-b border-white/5">
                      <p className="text-xs font-bold text-white truncate">{session.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate font-mono">{session.email}</p>
                    </div>
                    {isImpersonating && (
                      <button
                        onClick={() => { setMenuOpen(false); handleStopImpersonate(); }}
                        className="w-full px-3 py-2 text-left text-xs font-medium text-amber-300 hover:bg-amber-500/10 flex items-center gap-2 border-b border-white/5"
                      >
                        <ArrowLeftRight className="w-3.5 h-3.5" /> Voltar pra conta admin
                      </button>
                    )}
                    <button
                      onClick={() => { setMenuOpen(false); handleLogout(); }}
                      disabled={loggingOut}
                      className="w-full px-3 py-2 text-left text-xs font-medium text-red-400 hover:bg-red-500/10 flex items-center gap-2"
                    >
                      {loggingOut ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                      Sair
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
