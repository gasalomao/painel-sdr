"use client";

import { Suspense, useState, type FormEvent, type JSX } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Lock, Mail, AlertCircle, ArrowRight, ShieldCheck, Zap, Bot, Eye, EyeOff } from "lucide-react";
import { BRAND } from "@/lib/brand";
import styles from "./login.module.css";

function LoginForm(): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const fromPath = params.get("from") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
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
      // Avisa consumidores de sessão cacheada (header/sidebar/páginas) que o
      // estado mudou — login é SPA, sem reload o cache de módulo ficava velho.
      window.dispatchEvent(new Event("session-changed"));
      router.push(target);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.formContent}>
      <header className={styles.formHeader}>
        <h1 id="login-title">Bem-vindo de volta.</h1>
        <p>Entra e continua de onde parou.</p>
      </header>

      <form onSubmit={handleSubmit} aria-labelledby="login-title" aria-busy={loading} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="login-username">Usuário ou e-mail</label>
          <div className={styles.inputWrap}>
            <Mail aria-hidden="true" className={styles.fieldIcon} />
            <Input
              id="login-username"
              name="username"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@empresa.com.br"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={error ? "login-error" : undefined}
              required
              className={styles.input}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label htmlFor="login-password">Senha</label>
          <div className={styles.inputWrap}>
            <Lock aria-hidden="true" className={styles.fieldIcon} />
            <Input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Sua senha"
              autoComplete="current-password"
              aria-describedby={error ? "login-error" : undefined}
              required
              className={`${styles.input} ${styles.passwordInput}`}
            />
            <button
              type="button"
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              aria-pressed={showPassword}
              aria-controls="login-password"
              onClick={() => setShowPassword((visible) => !visible)}
              className={styles.passwordToggle}
            >
              {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
        </div>

        {error && (
          <div id="login-error" role="alert" className={styles.error}>
            <AlertCircle aria-hidden="true" />
            <p>{error}</p>
          </div>
        )}

        <Button type="submit" disabled={loading} className={styles.submit}>
          {loading ? (
            <><Loader2 aria-hidden="true" className={styles.spinner} /> Entrando…</>
          ) : (
            <>Entrar <ArrowRight aria-hidden="true" /></>
          )}
        </Button>
      </form>

      <p className={styles.accessHelp}>
        Não tem acesso?<br />
        <span>Fale com o administrador da sua conta.</span>
      </p>
      <p className={styles.copyright}>
        &copy; {new Date().getFullYear()} Salomão AI · Todos os direitos reservados
      </p>
    </div>
  );
}

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

export default function LoginPage(): JSX.Element {
  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <div className={styles.brand}>
          <div className={styles.logoFrame}>
            <Image src={BRAND.logoUrl} alt={BRAND.name} width={200} height={200} priority unoptimized className={styles.logo} />
          </div>
          <p>Sua equipe de IA no WhatsApp</p>
        </div>

        <aside className={styles.story} aria-label="Conheça a Salomão AI">
          <div className={styles.storyContent}>
            <h2 className={styles.headline}>
              <span>Atende.</span>
              <span>Qualifica.</span>
              <span>Fecha.</span>
            </h2>
            <p className={styles.intro}>
              A IA da Salomão conversa no seu WhatsApp <strong>24 horas por dia</strong> com a
              personalidade da sua marca, consulta os <strong>seus próprios documentos</strong> sem
              alucinar e marca reunião direto no <strong>seu Google Calendar</strong>.
            </p>
            <ul className={styles.features}>
              {FEATURES.map((feature) => (
                <li key={feature.title}>
                  <feature.icon aria-hidden="true" />
                  <div>
                    <p className={styles.featureTitle}>{feature.title}</p>
                    <p className={styles.featureDescription}>{feature.desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.brandFooter}>
            <span>Feita no Brasil</span>
            <span>Suporte em PT-BR</span>
            <span>Dados isolados por cliente</span>
          </div>
        </aside>

        <section className={styles.formPanel} aria-label="Acessar sua conta">
          <Suspense
            fallback={
              <div role="status" className={styles.skeleton}>
                <Loader2 aria-hidden="true" className={styles.spinner} />
                <p>Carregando…</p>
              </div>
            }
          >
            <LoginForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
