import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Assets vendor minificados e scripts one-off CommonJS não são fonte:
    "public/**",
    "scripts/recover-sdr-chats.js",
  ]),
  {
    // Política de lint: o codebase usa `any` extensivamente (~1300 casos em
    // ~200 arquivos, pré-existentes). Regra permanece VISÍVEL como warning até
    // existir esforço dedicado de tipagem; como error ela tornava o gate
    // `npm run lint` permanentemente vermelho e inútil.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
