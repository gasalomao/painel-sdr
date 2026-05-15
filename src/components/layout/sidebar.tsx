"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  MapPin,
  Bot,
  ChevronLeft,
  Menu,
  Smartphone,
  History,
  Zap,
  Repeat,
  Settings2,
  Coins,
  MoreHorizontal,
  X,
  Cpu,
  BookOpen,
  ShieldAlert,
  BarChart3,
  UserCheck,
  Trophy,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetClose } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Cada item tem `feature` — chave que bate com client.features no DB. Quando
// o cliente não tem aquela feature true, o item some do menu. Items SEM
// feature key (admin, login, etc) são sempre visíveis pra quem tem acesso.
const navItems: Array<{ href: string; label: string; icon: any; feature?: string; adminOnly?: boolean }> = [
  { href: "/",               label: "Dashboard",        icon: LayoutDashboard, feature: "dashboard" },
  { href: "/leads",          label: "Leads (CRM)",      icon: Users,           feature: "leads" },
  { href: "/chat",           label: "Chat",             icon: MessageSquare,   feature: "chat" },
  { href: "/agente",         label: "Agente IA",        icon: Bot,             feature: "agente" },
  { href: "/automacao",      label: "Automação",        icon: Cpu,             feature: "automacao" },
  { href: "/disparo",        label: "Disparo em Massa", icon: Zap,             feature: "disparo" },
  { href: "/follow-up",      label: "Follow-up",        icon: Repeat,          feature: "followup" },
  { href: "/captador",       label: "Captador Maps",    icon: MapPin,          feature: "captador" },
  { href: "/inteligencia",   label: "Inteligência",     icon: BarChart3,       feature: "inteligencia" },
  { href: "/whatsapp",       label: "WhatsApp",         icon: Smartphone,      feature: "whatsapp" },
  { href: "/historico-ia",   label: "Histórico IA",     icon: History,         feature: "historico" },
  { href: "/tokens",         label: "Tokens IA",        icon: Coins,           feature: "tokens" },
  { href: "/configuracoes",  label: "Configurações",    icon: Settings2,       feature: "configuracoes" },
  // Item exclusivo de admin — aparece com badge separado
  { href: "/admin/clientes", label: "Clientes",         icon: UserCheck,       adminOnly: true },
];

type SessionData = {
  authenticated: boolean;
  isAdmin?: boolean;
  impersonating?: boolean;
  features?: Record<string, boolean>;
  name?: string;
};

// Hook leve que pega a sessão atual. Cacheia em window pra não bater no
// endpoint a cada render. Atualiza quando usuário troca de cliente
// (impersonate / logout) via evento `session-changed`.
function useSession(): SessionData | null {
  const [session, setSession] = useState<SessionData | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        const d = await r.json();
        if (!cancelled) setSession(d);
      } catch {
        if (!cancelled) setSession({ authenticated: false });
      }
    };
    load();
    const handler = () => load();
    window.addEventListener("session-changed", handler);
    return () => { cancelled = true; window.removeEventListener("session-changed", handler); };
  }, []);
  return session;
}

// Filtra navItems baseado em sessão. Admin sempre vê tudo (não-impersonando).
function filterNav(items: typeof navItems, session: SessionData | null) {
  if (!session?.authenticated) return [];
  const isAdmin = !!session.isAdmin && !session.impersonating;
  const features = session.features || {};
  return items.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (isAdmin) return true; // admin vê tudo
    if (!item.feature) return true;
    return features[item.feature] !== false; // default true se não setado
  });
}

// Primary tabs shown in bottom nav bar (most used on mobile)
const bottomNavItems = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/agente", label: "Agente", icon: Bot },
];

function SidebarContent({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  const visibleNav = filterNav(navItems, session);

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center glow-primary shrink-0">
          <Bot className="w-5 h-5 text-primary-foreground" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-sm font-bold tracking-tight text-foreground">Salomão AI</h1>
            <p className="text-[11px] text-muted-foreground">Painel SDR</p>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0 w-7 h-7 hidden lg:flex"
          onClick={onToggle}
        >
          <ChevronLeft className={cn("w-4 h-4 transition-transform duration-200", collapsed && "rotate-180")} />
        </Button>
      </div>

      <Separator className="mx-3 w-auto" />

      {/* Nav Items */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {visibleNav.map((item) => {
          const isActive = pathname === item.href;
          const ItemIcon = item.icon;

          const linkContent = (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                "min-h-[44px]", /* Touch-friendly */
                isActive
                  ? "bg-primary/15 text-primary glow-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              <ItemIcon className={cn("w-[18px] h-[18px] shrink-0", isActive && "text-primary")} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                      "min-h-[44px]",
                      isActive
                        ? "bg-primary/15 text-primary glow-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    )}
                  >
                    <ItemIcon className={cn("w-[18px] h-[18px] shrink-0", isActive && "text-primary")} />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right" className="font-medium">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          }

          return linkContent;
        })}
      </nav>

      {/* Footer */}
      <div className="p-4">
        <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50", collapsed && "justify-center")}>
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse-dot" />
          {!collapsed && <span className="text-xs text-muted-foreground">Sistema Online</span>}
        </div>
      </div>
    </div>
  );
}

function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const session = useSession();
  const visibleNav = filterNav(navItems, session);

  // Close "more" sheet when navigating
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Bottom Navigation Bar */}
      <nav
        className={cn(
          "lg:hidden fixed bottom-0 left-0 right-0 z-50",
          "glass border-t border-white/10",
          "flex items-stretch justify-around",
          "h-[var(--bottom-nav-height)]",
          "pb-[var(--safe-bottom)]",
          "mobile-bottom-nav"
        )}
      >
        {bottomNavItems.map((item) => {
          const isActive = pathname === item.href;
          const ItemIcon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center flex-1 gap-0.5 pt-1.5 transition-colors",
                "active:bg-white/5",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <ItemIcon className={cn("w-5 h-5", isActive && "text-primary")} />
              <span className={cn(
                "text-[10px] font-bold",
                isActive ? "text-primary" : "text-muted-foreground"
              )}>
                {item.label}
              </span>
              {isActive && (
                <div className="w-5 h-0.5 rounded-full bg-primary mt-0.5" />
              )}
            </Link>
          );
        })}

        {/* More button */}
        <button
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex flex-col items-center justify-center flex-1 gap-0.5 pt-1.5 transition-colors",
            "active:bg-white/5",
            "text-muted-foreground"
          )}
        >
          <MoreHorizontal className="w-5 h-5" />
          <span className="text-[10px] font-bold">Mais</span>
        </button>
      </nav>

      {/* "More" Sheet — shows all remaining navigation items */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="glass border-t border-white/10 rounded-t-3xl p-0 max-h-[70vh]">
          <div className="p-4 pb-2 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-sm font-bold text-white">Menu completo</h3>
            </div>
            <button
              onClick={() => setMoreOpen(false)}
              className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Drag indicator */}
          <div className="flex justify-center py-2">
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>

          <nav className="px-3 pb-6 space-y-1 overflow-y-auto">
            {visibleNav.map((item) => {
              const isActive = pathname === item.href;
              const ItemIcon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
                    "min-h-[48px] active:bg-white/5",
                    isActive
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground"
                  )}
                >
                  <div className={cn(
                    "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                    isActive ? "bg-primary/20" : "bg-white/5"
                  )}>
                    <ItemIcon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground")} />
                  </div>
                  <span className={cn(isActive && "text-primary font-bold")}>{item.label}</span>
                  {isActive && <div className="ml-auto w-2 h-2 rounded-full bg-primary" />}
                </Link>
              );
            })}
          </nav>

          {/* Safe area padding */}
          <div style={{ height: "var(--safe-bottom)" }} />
        </SheetContent>
      </Sheet>
    </>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col border-r border-border glass transition-all duration-300",
          collapsed ? "w-[68px]" : "w-[240px]"
        )}
      >
        <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </aside>

      {/* Mobile Bottom Navigation Bar */}
      <MobileBottomNav />
    </>
  );
}
