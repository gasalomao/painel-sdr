import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Diretório vazio e exclusivo também isola o carregamento automático de .env do Vite.
export default defineConfig({
  envDir: mkdtempSync(path.join(tmpdir(), "painel-sdr-backup-tests-")),
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
  test: {
    environment: "jsdom",
    include: ["src/lib/__tests__/backup-*.test.ts", "src/components/__tests__/backup-*.test.tsx"],
    setupFiles: [],
    clearMocks: true,
    restoreMocks: true,
    env: { LIVE_E2E: "0", RUN_LIVE_TESTS: "0", BACKUP_WORKER_ENABLED: "false" },
  },
});
