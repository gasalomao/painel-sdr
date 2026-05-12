import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Salomão AI — Painel SDR",
  description: "Painel administrativo para gestão de leads, atendimento e captação",
  viewport: "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className={`${inter.variable} font-sans`}>
        <TooltipProvider>
          <div className="flex h-[100dvh] overflow-hidden">
            <Sidebar />
            <main className="flex-1 min-w-0">
              {children}
            </main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
