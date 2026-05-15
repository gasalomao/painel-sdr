"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loader2, Lock, Mail, AlertCircle, Shield } from "lucide-react";

export default function LoginPage() {
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
      // Admin abre no painel normal (Dashboard) — acessa Clientes pelo menu lateral.
      // Cliente também vai pra raiz (ou destino original se foi redirecionado pra login).
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-neutral-950 via-purple-950/30 to-blue-950/30 p-4">
      <div className="w-full max-w-md">
        {/* Branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-purple-600 shadow-xl shadow-primary/30 mb-4">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white">Painel SDR</h1>
          <p className="text-xs text-muted-foreground mt-1">Entre com sua conta administrador ou cliente</p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="glass-card rounded-3xl p-8 border-white/10 bg-white/[0.02] space-y-5 shadow-2xl"
        >
          {/* Email */}
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Mail className="w-3 h-3" /> Email
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              autoComplete="username"
              required
              autoFocus
              className="bg-white/5 border-white/10 h-12 rounded-xl text-sm"
            />
          </div>

          {/* Senha */}
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Lock className="w-3 h-3" /> Senha
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              className="bg-white/5 border-white/10 h-12 rounded-xl text-sm"
            />
          </div>

          {/* Erro */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Submit */}
          <Button
            type="submit"
            disabled={loading || !email || !password}
            className={cn(
              "w-full h-12 rounded-xl bg-gradient-to-r from-primary to-purple-600 hover:from-primary/90 hover:to-purple-600/90",
              "text-primary-foreground font-bold text-sm uppercase tracking-widest gap-2 shadow-lg shadow-primary/20"
            )}
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Entrando...</>
            ) : (
              <>Entrar</>
            )}
          </Button>

          {/* Hint pra primeiro acesso */}
          <p className="text-[10px] text-center text-muted-foreground pt-2 border-t border-white/5">
            Não tem conta? Apenas o administrador pode criar contas de cliente.
          </p>
        </form>
      </div>
    </div>
  );
}
