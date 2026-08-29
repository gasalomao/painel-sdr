import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  compress: true,
  reactStrictMode: true,
  // next/image precisa do hostname autorizado pra carregar imagens externas.
  // i.ibb.co = onde a logo Salomão AI está hospedada (CDN público).
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ibb.co" },
      { protocol: "https", hostname: "mmg.whatsapp.net" },
      { protocol: "https", hostname: "pps.whatsapp.net" },
      { protocol: "https", hostname: "**.whatsapp.net" },
      { protocol: "https", hostname: "**.googleusercontent.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  // Type-check no build REATIVADO (2026-08-28): `npx tsc --noEmit` está limpo
  // e o `ignoreBuildErrors: true` de antes mascarava regressões silenciosas.
  // Se a VPS modesta voltar a estourar OOM no build, use
  // NODE_OPTIONS=--max-old-space-size=4096 npm run build em vez de re-desligar.
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: [
    "puppeteer-core",
    "puppeteer-extra",
    "puppeteer-extra-plugin-stealth",
  ],
  // Otimização de bundle: instrui o Next a tree-shake melhor e agrupar
  // imports de pacotes grandes em chunks separados (menos JS baixado em
  // cada página que não usa esses pacotes).
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "date-fns",
      "recharts",
      "react-big-calendar",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
    ],
  },
};

export default nextConfig;
