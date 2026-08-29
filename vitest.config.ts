import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Suites live (live-*, *.live, *.e2e, test_*, whisper/petshop) agora se
    // AUTOPULAM via guards de env (LIVE_E2E / RUN_LIVE_TESTS / LIVE_PETSHOP /
    // E2E_*) dentro dos arquivos — npm test fica offline e verde, e a
    // execução explícita funciona: $env:LIVE_E2E="1"; npx vitest run <arquivo>.
    exclude: ["**/node_modules/**"],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ["src/lib/__tests__/setup.ts"],
  },
});
