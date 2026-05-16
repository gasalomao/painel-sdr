import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  compress: true,
  reactStrictMode: true,
  // Type-check e ESLint são pesados pra caramba no Next 16 (Turbopack roda
  // workers de ~2 GB cada). Em VPS modesta o build estoura OOM. Desligamos
  // aqui — o IDE continua mostrando os erros em desenvolvimento.
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: [
    "puppeteer-core",
    "puppeteer-extra",
    "puppeteer-extra-plugin-stealth",
  ],
};

export default nextConfig;
