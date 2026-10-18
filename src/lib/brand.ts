/**
 * Brand assets centralizados — única fonte de verdade pra logo/cores da marca.
 * Login e navegação usam logoUrl; ícones de aba e celular ficam em src/app.
 */

export const BRAND = {
  name: "Salomão AI",
  // Original oficial incluído no deploy, sem depender de hospedagem externa.
  logoUrl: "/brand/salomao-ai.png",
  // Cores da marca (alinhadas ao login redesign — emerald → cyan).
  // Use direto em estilos quando precisar (className TW continua funcionando).
  colors: {
    primary: "#10b981",   // emerald-500
    secondary: "#06b6d4", // cyan-500
    accent: "#84cc16",    // lime-500 (verde da logo)
  },
} as const;
