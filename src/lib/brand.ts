/**
 * Brand assets centralizados — única fonte de verdade pra logo/cores da marca.
 * Trocar URL aqui propaga pro app inteiro (login, sidebar, favicon, emails, etc).
 */

export const BRAND = {
  name: "Salomão AI",
  // Logo hospedada em CDN público (i.ibb.co — autorizado em next.config.ts).
  // Trocar aqui se mudar a hospedagem.
  logoUrl: "https://i.ibb.co/5W2qgpmH/BG-MINHA-LOGO-1.png",
  // Cores da marca (alinhadas ao login redesign — emerald → cyan).
  // Use direto em estilos quando precisar (className TW continua funcionando).
  colors: {
    primary: "#10b981",   // emerald-500
    secondary: "#06b6d4", // cyan-500
    accent: "#84cc16",    // lime-500 (verde da logo)
  },
} as const;
