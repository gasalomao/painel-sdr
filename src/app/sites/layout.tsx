import Link from "next/link";
import { LayoutTemplate } from "lucide-react";
import { Toaster } from "sonner";

export default function SitesLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full min-h-0 flex-col pb-[calc(var(--bottom-nav-height)+var(--safe-bottom))] lg:pb-0">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-3 py-3 sm:px-6">
      <Link href="/sites" className="flex items-center gap-2 font-semibold"><LayoutTemplate className="size-5 text-primary" aria-hidden="true" />Site Studio IA</Link>
      <nav aria-label="Site Studio" className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <Link className="hover:text-foreground focus-visible:underline" href="/sites">Meus Sites</Link>
        <Link className="hover:text-foreground focus-visible:underline" href="/sites/skills">Skills</Link>
        <Link className="hover:text-foreground focus-visible:underline" href="/sites/settings">Configurações</Link>
      </nav>
    </header>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    <Toaster richColors position="top-center" theme="dark" closeButton toastOptions={{ closeButtonAriaLabel: "Fechar aviso" }} />
  </div>;
}
