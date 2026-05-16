"use client";

import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ImpersonationBanner() {
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        const d = await r.json();
        if (!cancelled && d.authenticated && d.impersonating) {
          setSession(d);
        } else if (!cancelled) {
          setSession(null);
        }
      } catch {
        if (!cancelled) setSession(null);
      }
    };
    load();
    const handler = () => load();
    window.addEventListener("session-changed", handler);
    return () => { cancelled = true; window.removeEventListener("session-changed", handler); };
  }, []);

  if (!session) return null;

  async function handleStop() {
    try {
      const r = await fetch("/api/admin/stop-impersonate", { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        if (data.redirectedToLogin) {
          window.location.href = "/login";
        } else {
          window.location.href = "/admin/clientes";
        }
      } else {
        alert("Erro ao restaurar a sessão de administrador.");
      }
    } catch {
      alert("Erro de conexão ao restaurar a sessão.");
    }
  }

  return (
    <div className="w-full bg-[#820ad1] text-white px-4 py-2 flex items-center justify-between text-sm shrink-0 z-50">
      <div className="flex items-center gap-4">
        <Button 
          variant="secondary" 
          size="sm" 
          onClick={handleStop}
          className="bg-[#facc15] hover:bg-[#eab308] text-black font-bold h-8 border-none"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sair
        </Button>
        <span className="font-bold hidden sm:inline">Modo de apresentação</span>
      </div>
      
      <div className="flex-1 text-center font-medium px-4 truncate">
        Você está gerenciando a conta de <strong className="font-black">{session.email}</strong>
      </div>
      
      <div className="w-[100px] hidden sm:block" /> {/* Spacer to balance flex */}
    </div>
  );
}
