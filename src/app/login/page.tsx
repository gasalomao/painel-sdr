"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loader2, Lock, Mail, AlertCircle, ArrowRight, Bot } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const fromPath = params.get("from") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || "Falha ao entrar");
        return;
      }
      const target = fromPath && fromPath !== "/login" && !fromPath.startsWith("/login") ? fromPath : "/";
      router.push(target);
      router.refresh();
    } catch (err: any) {
      setError(err?.message || "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-[420px] animate-in fade-in zoom-in-95 duration-700 fill-mode-forwards">
      
      {/* Logo & Header */}
      <div className="flex flex-col items-center mb-10">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-purple-600 to-blue-500 p-[1px] mb-6 shadow-2xl shadow-purple-500/20">
          <div className="w-full h-full bg-neutral-950/90 backdrop-blur-xl rounded-[15px] flex items-center justify-center">
            <Bot className="w-8 h-8 text-white drop-shadow-md" />
          </div>
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-br from-white to-white/60 mb-2">
          Salomão AI
        </h1>
        <p className="text-sm font-medium text-muted-foreground text-center max-w-[280px]">
          Acesse o Painel SDR para gerenciar seus leads e integrações.
        </p>
      </div>

      {/* Form Card */}
      <div className="relative group">
        {/* Glowing border effect on hover */}
        <div className="absolute -inset-[1px] rounded-[24px] bg-gradient-to-b from-white/10 to-transparent opacity-50 group-hover:opacity-100 transition duration-500 pointer-events-none" />
        
        <form
          onSubmit={handleSubmit}
          className="relative rounded-[24px] p-8 bg-black/40 backdrop-blur-2xl border border-white/[0.08] shadow-2xl space-y-6"
        >
          
          {/* Inputs */}
          <div className="space-y-4">
            <div className="space-y-2 group/input">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/50 flex items-center gap-2 transition-colors group-focus-within/input:text-purple-400">
                <Mail className="w-3.5 h-3.5" /> Usuário ou E-mail
              </label>
              <div className="relative">
                <Input
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin ou seu@email.com"
                  autoComplete="username"
                  required
                  autoFocus
                  className="bg-white/5 border-white/10 h-12 rounded-xl text-sm px-4 focus-visible:ring-1 focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50 transition-all placeholder:text-white/20"
                />
              </div>
            </div>

            <div className="space-y-2 group/input">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/50 flex items-center gap-2 transition-colors group-focus-within/input:text-purple-400">
                <Lock className="w-3.5 h-3.5" /> Senha
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                className="bg-white/5 border-white/10 h-12 rounded-xl text-sm px-4 focus-visible:ring-1 focus-visible:ring-purple-500/50 focus-visible:border-purple-500/50 transition-all placeholder:text-white/20"
              />
            </div>
          </div>

          {error && (
            <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <p className="text-xs font-bold text-red-200">{error}</p>
            </div>
          )}

          <Button
            type="submit"
            disabled={loading}
            className="w-full h-12 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold rounded-xl shadow-xl shadow-purple-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <span className="flex items-center gap-2">
                Entrar no Painel <ArrowRight className="w-4 h-4" />
              </span>
            )}
          </Button>

          <p className="text-[10px] text-center text-white/30 pt-2 font-medium">
            &copy; {new Date().getFullYear()} Salomão AI. Todos os direitos reservados.
          </p>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-[100dvh] flex bg-[#030303] text-foreground overflow-hidden relative">
      {/* Background Effects */}
      <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] bg-purple-600/15 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50vw] h-[50vw] bg-blue-600/15 blur-[120px] rounded-full pointer-events-none" />
      
      <div className="flex-1 flex flex-col justify-center items-center p-6 relative z-10 w-full">
        <Suspense fallback={
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 text-purple-500 animate-spin" />
            <p className="text-sm font-medium text-muted-foreground animate-pulse">Carregando...</p>
          </div>
        }>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
