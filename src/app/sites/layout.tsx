"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { Toaster } from "sonner";
import styles from "./sites.module.css";

export default function SitesLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  return <div className={`${styles.surface} flex h-full min-h-0 flex-col pb-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:pb-0`}>
    <header className={styles.shellHeader}>
      <Link href="/sites" className={styles.brand}><LayoutTemplate aria-hidden="true" />Sites IA</Link>
      <nav aria-label="Sites IA" className={styles.nav}>
        <Link aria-current={pathname === "/sites" ? "page" : undefined} href="/sites">Meus sites</Link>
        <Link aria-current={pathname === "/sites/skills" ? "page" : undefined} href="/sites/skills">Diretrizes de IA</Link>
        <Link aria-current={pathname === "/sites/settings" ? "page" : undefined} href="/sites/settings">Configurações</Link>
      </nav>
    </header>
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    <Toaster richColors position="top-center" theme="dark" closeButton toastOptions={{ closeButtonAriaLabel: "Fechar aviso" }} />
  </div>;
}
