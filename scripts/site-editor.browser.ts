import { expect, test, type Page } from "@playwright/test";
import { getStarterFiles } from "../src/lib/sites/starter";
import type { WebsiteFiles } from "../src/lib/sites/types";

const projectId = "test-project";
const runId = "44444444-4444-4444-8444-444444444444";
const source = (title: string): WebsiteFiles => ({ ...getStarterFiles(), "src/App.tsx": `export default function App(){return <main><h1>${title}</h1></main>}` });

async function mockEditorAPI(page: Page, state: { checkpoint: WebsiteFiles | null; version: string }): Promise<void> {
  await page.route(`**/api/sites/${projectId}/files*`, async route => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("run_id")) {
      return route.fulfill({ status: 404, json: { error: "run_id required" } });
    }
    if (state.checkpoint) {
      await route.fulfill({
        json: { version: state.version, run_id: runId, base_revision_id: "base", files: state.checkpoint },
        headers: { "Cache-Control": "no-store", ETag: `"${state.version}"` }
      });
    } else {
      await route.fulfill({ status: 404, json: { error: "No checkpoint" } });
    }
  });
}

test("polls confirmed checkpoints into preview without promoting them to editor", async ({ page }) => {
  const state = { checkpoint: source("Checkpoint inicial"), version: "one" };
  await mockEditorAPI(page, state);
  await page.goto(`/?run_id=${runId}`);

  await expect(page.getByRole("heading", { name: "Projeto sintético", exact: true })).toBeVisible();
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Checkpoint inicial" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Rascunho confirmado do agente.", { exact: false })).toBeVisible();

  // Update checkpoint
  state.checkpoint = source("Checkpoint seguinte");
  state.version = "two";
  await expect(preview.getByRole("heading", { name: "Checkpoint seguinte" })).toBeVisible({ timeout: 10_000 });

  // Editor should still show original saved revision
  const editor = page.getByRole("textbox", { name: "src/App.tsx", exact: true });
  await expect(editor).toHaveValue(source("Revisão salva")["src/App.tsx"]);
  await expect(editor).not.toBeEditable();
});

test("preserves manual draft when polling fetches a late checkpoint", async ({ page }) => {
  const state = { checkpoint: null as WebsiteFiles | null, version: "initial" };
  await mockEditorAPI(page, state);
  await page.goto(`/?run_id=${runId}`);

  // Wait for initial load - no checkpoint yet, so editor should be editable
  await expect(page.getByRole("heading", { name: "Projeto sintético", exact: true })).toBeVisible();
  await page.waitForTimeout(1000); // Let initial polling cycle complete

  const editor = page.getByRole("textbox", { name: "src/App.tsx", exact: true });
  await expect(editor).toBeEditable();

  // Make manual edit
  const manual = source("Edição manual preservada")["src/App.tsx"];
  await editor.fill(manual);

  // Now update checkpoint while manual draft exists
  state.checkpoint = source("Resposta posterior");
  state.version = "one";
  await page.waitForTimeout(3_000); // Let polling cycle run

  // Manual draft must be preserved despite checkpoint arrival
  await expect(editor).toHaveValue(manual);
  await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeDisabled();
});

test("stops showing stale checkpoint when state updated", async ({ page }) => {
  const state = { checkpoint: source("Checkpoint antigo"), version: "one" };
  await mockEditorAPI(page, state);
  await page.goto(`/?run_id=${runId}`);

  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Checkpoint antigo" })).toBeVisible({ timeout: 10_000 });

  // Clear checkpoint to simulate terminal status
  state.checkpoint = null;
  await page.getByRole("button", { name: "Atualizar estado", exact: true }).click();
  await page.waitForTimeout(3_000);

  // Should revert to saved revision
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 10_000 });
});
