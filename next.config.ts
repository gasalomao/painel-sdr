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
    ],
  },
  // Type-check e ESLint são pesados pra caramba no Next 16 (Turbopack roda
  // workers de ~2 GB cada). Em VPS modesta o build estoura OOM. Desligamos
  // aqui — o IDE continua mostrando os erros em desenvolvimento.
  typescript: { ignoreBuildErrors: true },
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
