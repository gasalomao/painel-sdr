"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Lock, Mail, AlertCircle, ArrowRight, ShieldCheck, Zap, Bot } from "lucide-react";
import { BRAND } from "@/lib/brand";

/**
 * /login — entrada da plataforma Salomão AI.
 *
 * Design:
 *   • Split-screen: esquerda = brand + claims; direita = form de login.
 *     Em mobile colapsa pra coluna única.
 *   • Paleta alinhada com a logo (verde-lima → cyan/azul). NÃO usa roxo,
 *     que apagaria o gradiente verde-azul da logo.
 *   • Logo carregada de /public/logo.png — fallback pra placeholder caso
 *     o arquivo ainda não tenha sido colocado.
 *   • Removida toda referência a "SDR" / "Painel SDR" — agora é só
 *     "Salomão AI".
 */

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
    <div className="w-full max-w-[420px] animate-in fade-in slide-in-from-bottom-4 duration-700 fill-mode-forwards">
      <div className="lg:hidden flex justify-center mb-8">
        <Image
          src={BRAND.logoUrl}
          alt="Salomão AI"
          width={140}
          height={140}
          priority
          unoptimized
          className="object-contain drop-shadow-[0_0_25px_rgba(132,204,22,0.3)]"
        />
      </div>

      <div className="hidden lg:block mb-8">
        <h2 className="text-3xl font-black tracking-tight text-white">Bem-vindo de volta.</h2>
        <p className="text-sm text-white/60 mt-2 font-medium">
          Entra e continua de onde parou.
        </p>
      </div>

      <div className="relative">
        <div className="absolute -inset-px rounded-[24px] bg-gradient-to-b from-primary/20 via-transparent to-primary/10 opacity-70 pointer-events-none" />

        <form
          onSubmit={handleSubmit}
          className="relative rounded-[24px] p-8 bg-black/50 backdrop-blur-2xl border border-white/[0.08] shadow-2xl shadow-primary/10 space-y-6"
        >
          <div className="space-y-4">
            <div className="space-y-2 group/input">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/50 flex items-center gap-2 transition-colors group-focus-within/input:text-primary">
                <Mail className="w-3.5 h-3.5" /> Usuário ou e-mail
              </label>
              <Input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@empresa.com.br"
                autoComplete="username"
                required
                autoFocus
                className="bg-white/5 border-white/10 h-12 rounded-xl text-sm px-4 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40 transition-all placeholder:text-white/20"
              />
            </div>

            <div className="space-y-2 group/input">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/50 flex items-center gap-2 transition-colors group-focus-within/input:text-primary">
                <Lock className="w-3.5 h-3.5" /> Senha
              </label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                className="bg-white/5 border-white/10 h-12 rounded-xl text-sm px-4 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40 transition-all placeholder:text-white/20"
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
            className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-black rounded-xl shadow-xl shadow-primary/30 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100 uppercase tracking-wider text-sm glow-primary"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <span className="flex items-center gap-2">
                Entrar <ArrowRight className="w-4 h-4" />
              </span>
            )}
          </Button>

          <p className="text-[10px] text-center text-white/40 pt-1 font-medium">
            Não tem acesso? <span className="text-white/60">Fale com o administrador da sua conta.</span>
          </p>
          <p className="text-[10px] text-center text-white/25 font-medium">
            &copy; {new Date().getFullYear()} Salomão AI · Todos os direitos reservados
          </p>
        </form>
      </div>
    </div>
  );
}

// Copy escrita pra comunicar VALOR (não feature). Cada bullet começa com
// a dor que resolve + prova concreta — princípio "outcome over feature".
const FEATURES = [
  {
    icon: Bot,
    title: "Conversa como você atenderia",
    desc: "Personalidade, tom e funil próprios. A IA qualifica o lead e sabe quando passar pra você.",
  },
  {
    icon: ShieldCheck,
    title: "Nunca inventa resposta",
    desc: "Cola seus preços, FAQ e políticas — a IA consulta o seu documento. Zero alucinação.",
  },
  {
    icon: Zap,
    title: "Agenda, dispara e faz follow-up",
    desc: "Marca reunião no Google Calendar, dispara em massa e retoma quem sumiu — sozinha.",
  },
];

export default function LoginPage() {
  return (
    <div className="min-h-[100dvh] flex bg-background text-foreground overflow-hidden relative">
      {/* Blurs com a paleta DO SISTEMA (primary blue) + um toque verde-cyan
          discreto pra ecoar a logo sem competir. Antes era 100% verde —
          ficava destoante do interior do app que é primary blue. */}
      <div className="absolute top-[-20%] left-[-10%] w-[55vw] h-[55vw] bg-primary/12 blur-[140px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[55vw] h-[55vw] bg-primary/12 blur-[140px] rounded-full pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(132,204,22,0.04),transparent_60%)] pointer-events-none" />

      <aside className="hidden lg:flex flex-col justify-between w-[45%] xl:w-[50%] p-12 xl:p-16 relative z-10 border-r border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/25 flex items-center justify-center p-1.5">
            <Image
              src={BRAND.logoUrl}
              alt="Salomão AI"
              width={48}
              height={48}
              priority
              unoptimized
              className="object-contain drop-shadow-[0_0_16px_rgba(132,204,22,0.35)]"
            />
          </div>
          <div>
            <p className="text-lg font-black tracking-tight text-white leading-none">Salomão AI</p>
            <p className="text-[10px] uppercase tracking-[0.25em] text-primary/80 mt-1 font-bold">
              Sua equipe de IA no WhatsApp
            </p>
          </div>
        </div>

        <div className="space-y-10 max-w-md">
          <div>
            {/* Headline em 3 batidas — fórmula clássica que funciona pra
                produto vendido por outcome (Atende. Qualifica. Fecha.).
                Cada linha foca num resultado, não em feature.
                Gradient só na primeira linha pra criar hierarquia visual.
                Cor branca / branca-fade nas outras 2 dá ritmo. */}
            <h1 className="text-5xl xl:text-6xl font-black tracking-tight leading-[1.05]">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary via-blue-300 to-cyan-300">
                Atende.
              </span>
              <br />
              <span className="text-white">Qualifica.</span>
              <br />
              <span className="text-white/40">Fecha.</span>
            </h1>
            <p className="text-sm xl:text-base text-white/65 mt-6 leading-relaxed max-w-md">
              A IA da Salomão conversa no seu WhatsApp <strong className="text-white">24 horas por dia</strong> com a
              personalidade da sua marca, consulta os <strong className="text-white">seus próprios documentos</strong> sem
              alucinar e marca reunião direto no <strong className="text-white">seu Google Calendar</strong>.
            </p>
          </div>

          <ul className="space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3 group">
                <div className="shrink-0 mt-0.5 p-2 rounded-xl bg-primary/10 ring-1 ring-primary/20 group-hover:ring-primary/50 transition">
                  <f.icon className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-bold text-white">{f.title}</p>
                  <p className="text-xs text-white/50 leading-relaxed mt-0.5">{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-4 text-[10px] text-white/30 font-medium uppercase tracking-[0.2em]">
          <span>🇧🇷 Feita no Brasil</span>
          <span className="w-1 h-1 rounded-full bg-white/20" />
          <span>Suporte em PT-BR</span>
          <span className="w-1 h-1 rounded-full bg-white/20" />
          <span>Dados isolados por cliente</span>
        </div>
      </aside>

      <div className="flex-1 flex flex-col justify-center items-center p-6 lg:p-12 relative z-10">
        <Suspense
          fallback={
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
              <p className="text-sm font-medium text-muted-foreground animate-pulse">Carregando…</p>
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
