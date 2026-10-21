"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  MapPin,
  Bot,
  ChevronLeft,
  Smartphone,
  Zap,
  Repeat,
  Settings2,
  Coins,
  MoreHorizontal,
  X,
  Cpu,
  BookOpen,
  ShieldAlert,
  UserCheck,
  Trophy,
  LogOut,
  CalendarDays,
  Globe,
  LayoutTemplate,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { LucideIcon } from "lucide-react";
import styles from "./sidebar.module.css";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Cada item tem `feature` — chave que bate com client.features no DB. Quando
// o cliente não tem aquela feature true, o item some do menu. Items SEM
// feature key (admin) são sempre visíveis pra quem tem acesso.
type NavItem = { href: string; label: string; icon: LucideIcon; feature?: string; adminOnly?: boolean };

// Items admin-only — aparecem no topo do menu, com destaque visual.
// "Clientes" é EXCLUSIVO de admin (cliente nunca vê, mesmo com feature marcada).
const adminItems: NavItem[] = [
  { href: "/admin/clientes", label: "Clientes", icon: UserCheck, adminOnly: true },
];

// Items normais do painel — filtrados pelas features do cliente atual.
// "Configurações" voltou pra cá: cliente só vê se admin marcar features.configuracoes.
// Admin (não-impersonando) sempre vê tudo.
const navItems: NavItem[] = [
  { href: "/",               label: "Dashboard",        icon: LayoutDashboard, feature: "dashboard" },
  { href: "/leads",          label: "Clientes (CRM)",      icon: Users,           feature: "leads" },
  { href: "/chat",           label: "Chat",             icon: MessageSquare,   feature: "chat" },
  { href: "/calendario",     label: "Calendário",       icon: CalendarDays,    feature: "calendario" },
  { href: "/agente",         label: "Agente IA",        icon: Bot,             feature: "agente" },
  { href: "/automacao",      label: "Automação",        icon: Cpu,             feature: "automacao" },
  { href: "/disparo",        label: "Disparo em Massa", icon: Zap,             feature: "disparo" },
  { href: "/prospeccao-sites", label: "Prospecção Sites", icon: Globe,        feature: "prospeccao_sites" },
  { href: "/sites",           label: "Sites IA",          icon: LayoutTemplate, feature: "sites" },
  { href: "/follow-up",      label: "Follow-up",        icon: Repeat,          feature: "followup" },
  { href: "/captador",       label: "Captador Maps",    icon: MapPin,          feature: "captador" },
  { href: "/whatsapp",       label: "WhatsApp",         icon: Smartphone,      feature: "whatsapp" },
  { href: "/tokens",         label: "Tokens IA",        icon: Coins,           feature: "tokens" },
  { href: "/organizador",    label: "Organizador IA",   icon: BookOpen,        feature: "organizador" },
  { href: "/configuracoes",  label: "Configurações",    icon: Settings2,       feature: "configuracoes" },
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
        if (!cancelled) {
          setSession(d);
          if (!d.authenticated && window.location.pathname !== "/login") {
            window.location.href = "/login";
          }
        }
      } catch {
        if (!cancelled) {
          setSession({ authenticated: false });
          if (window.location.pathname !== "/login") {
            window.location.href = "/login";
          }
        }
      }
    };
    load();
    const handler = () => load();
    window.addEventListener("session-changed", handler);
    return () => { cancelled = true; window.removeEventListener("session-changed", handler); };
  }, []);
  return session;
}

// Filtra items baseado em sessão. Admin (não-impersonando) vê tudo.
function filterNav(items: NavItem[], session: SessionData | null) {
  if (!session?.authenticated) return [];
  const isAdmin = !!session.isAdmin && !session.impersonating;
  const features = session.features || {};
  return items.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (isAdmin) return true; // admin vê tudo
    if (!item.feature) return true;
    // "sites" é premium opt-in: exige flag true (o backend também fail-closed).
    if (item.feature === "sites") return features[item.feature] === true;
    return features[item.feature] !== false; // default true se não setado
  });
}

// Primary tabs shown in bottom nav bar (most used on mobile)
const bottomNavItems = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/leads", label: "Clientes", icon: Users },
  { href: "/agente", label: "Agente", icon: Bot },
];

function SidebarContent({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  const visibleNav = filterNav(navItems, session);
  const visibleAdmin = filterNav(adminItems, session);

  return (
    <div className={styles.content}>
      <div className={styles.brand}>
        <div className={styles.logo}>
          <Image src={BRAND.logoUrl} alt={BRAND.name} width={40} height={40} className="object-contain" unoptimized />
        </div>
        {!collapsed && (
          <div className={styles.brandName}>
            <span>Salomão AI</span>
            <p>Plataforma</p>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={styles.toggle}
          onClick={onToggle}
          aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
          title={collapsed ? "Expandir menu" : "Recolher menu"}
          aria-expanded={!collapsed}
          aria-controls="desktop-navigation"
        >
          <ChevronLeft className={cn("w-4 h-4", collapsed && "rotate-180")} />
        </Button>
      </div>

      <nav id="desktop-navigation" aria-label="Navegação principal" className={styles.navigation}>
        {/* Bloco ADMIN — só aparece pra admin não-impersonando.
            Visual diferenciado (purple) pra distinguir da navegação do cliente. */}
        {visibleAdmin.length > 0 && (
          <div className={styles.adminSection}>
            {!collapsed && (
              <p className={styles.sectionLabel}>
                <ShieldAlert className="w-3 h-3" /> Administração
              </p>
            )}
            {visibleAdmin.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const ItemIcon = item.icon;
              const className = cn(styles.navLink, styles.adminLink, isActive && styles.active);
              const link = (
                <Link key={item.href} href={item.href} onClick={onNavigate} className={className} aria-label={item.label} aria-current={isActive ? "page" : undefined}>
                  <ItemIcon className="w-[18px] h-[18px] shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              );
              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger render={link} />
                    <TooltipContent side="right" className="font-medium">{item.label}</TooltipContent>
                  </Tooltip>
                );
              }
              return link;
            })}
          </div>
        )}

        {visibleNav.map((item) => {
          const isActive = pathname === item.href;
          const ItemIcon = item.icon;

          const linkContent = (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              className={cn(styles.navLink, isActive && styles.active)}
            >
              <ItemIcon className={cn("w-[18px] h-[18px] shrink-0", isActive && "text-primary")} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger render={linkContent} />
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
      <div className={styles.footer}>
        {/* Se impersonando: botão de voltar pra conta do admin */}
        {session?.impersonating && (
          <button
            onClick={async () => {
              try {
                const r = await fetch("/api/admin/stop-impersonate", { method: "POST" });
                const data = await r.json();
                if (data.redirectedToLogin) {
                  window.location.href = "/login";
                } else {
                  window.location.href = "/admin/clientes";
                }
              } catch {
                alert("Erro ao restaurar sessão.");
              }
            }}
            aria-label="Voltar para Admin"
            title={collapsed ? "Voltar para Admin" : undefined}
            className={cn(styles.navLink, styles.adminLink)}
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {!collapsed && <span>Voltar para Admin</span>}
          </button>
        )}

        {/* Deslogar real — volta pra tela de login */}
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.href = "/login";
          }}
          aria-label="Deslogar"
          title={collapsed ? "Deslogar" : undefined}
          className={cn(styles.navLink, styles.logout)}
        >
          <LogOut className="w-5 h-5 shrink-0" />
          {!collapsed && <span>Deslogar</span>}
        </button>

        <div className={styles.systemStatus} title="Sistema Online">
          <div className={styles.statusDot} />
          <span className={collapsed ? "sr-only" : undefined}>Sistema Online</span>
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
  const visibleAdmin = filterNav(adminItems, session);
  // No "Mais" do mobile, admin items vêm no topo seguidos da nav normal.
  const allMobileItems = [...visibleAdmin, ...visibleNav];

  // Close "more" sheet when navigating (a mudança vem de fora — rota nova)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMoreOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Bottom Navigation Bar */}
      <nav
        className={cn(
          "lg:hidden fixed bottom-0 left-0 right-0 z-50",
          styles.bottomNav,
          "flex items-stretch justify-around",
          "h-[calc(4rem+env(safe-area-inset-bottom,0px))]",
          "pb-[env(safe-area-inset-bottom,0px)]",
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
        <SheetContent side="bottom" showCloseButton={false} className={cn(styles.mobileSheet, "rounded-t-2xl p-0 max-h-[70vh] gap-0")}>
          <div className="p-4 pb-2 flex items-center justify-between border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center shrink-0">
                <Image src={BRAND.logoUrl} alt={BRAND.name} width={32} height={32} unoptimized className="object-contain" />
              </div>
              <SheetTitle className="text-sm font-semibold text-white">Menu completo</SheetTitle>
            </div>
            <button
              onClick={() => setMoreOpen(false)}
              aria-label="Fechar menu"
              className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

          {/* Drag indicator */}
          <div className="flex justify-center py-2">
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>

          <nav className="px-3 pb-6 space-y-1 overflow-y-auto">
            {allMobileItems.map((item) => {
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

            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all min-h-[48px] active:bg-white/5 text-red-400/80 mt-4"
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-red-500/10">
                <LogOut className="w-4 h-4 text-red-400" />
              </div>
              <span>Sair do sistema</span>
            </button>
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
  const pathname = usePathname();

  if (pathname === "/login") {
    return null;
  }

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={styles.sidebar}
        data-collapsed={collapsed}
      >
        <SidebarContent collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} />
      </aside>

      {/* Mobile Bottom Navigation Bar */}
      <MobileBottomNav />
    </>
  );
}
