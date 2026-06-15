import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImpersonationBanner } from "@/components/layout/impersonation-banner";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Salomão AI",
  description: "Plataforma de IA conversacional — agentes WhatsApp, automações, follow-ups e base de conhecimento.",
  icons: { icon: "https://i.ibb.co/5W2qgpmH/BG-MINHA-LOGO-1.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark">
      <body className={`${inter.variable} font-sans flex flex-col h-[100dvh] overflow-hidden`}>
        <TooltipProvider>
          <ImpersonationBanner />
          <div className="flex flex-1 overflow-hidden">
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
