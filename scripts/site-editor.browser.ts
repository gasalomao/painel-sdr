import { expect, test, type Page, type Route } from "@playwright/test";
import { getStarterFiles } from "../src/lib/sites/starter";
import type {
  WebsiteAsset,
  WebsiteBuild,
  WebsiteDeployment,
  WebsiteFiles,
  WebsiteMessage,
  WebsiteModel,
  WebsiteProject,
  WebsiteRevision,
  WebsiteRun,
  WebsiteSkill,
} from "../src/lib/sites/types";

interface CheckpointEnvelope {
  checkpoint: {
    version: string;
    run_id: string;
    base_revision_id: string | null;
    files: WebsiteFiles;
  } | null;
}

interface EditorMockState {
  project: WebsiteProject;
  files: WebsiteFiles;
  runs: WebsiteRun[];
  revisions: WebsiteRevision[];
  builds: WebsiteBuild[];
  deployments: WebsiteDeployment[];
  messages: WebsiteMessage[];
  assets: WebsiteAsset[];
  models: WebsiteModel[];
  skills: WebsiteSkill[];
  checkpoints: Map<string, { etag: string; data: CheckpointEnvelope }>;
  checkpointNotModifiedCount: number;
  sseConnections: number;
  onCanonicalFilesRequest?: (route: Route, defaultRespond: () => Promise<void>) => Promise<void>;
  onRunsRequest?: (route: Route, defaultRespond: () => Promise<void>) => Promise<void>;
  onCheckpointRequest?: (runId: string, route: Route, defaultRespond: () => Promise<void>) => Promise<void>;
  onSseRequest?: (runId: string, route: Route) => Promise<void>;
}

const PROJECT_ID = "test-project";
const CLIENT_ID = "client-1";
const ACTOR_ID = "user-1";
const NOW = "2026-10-08T12:00:00.000Z";
const ACCEPTED_PREVIEW_IFRAME = '[data-preview-state="accepted"] iframe[title="Sandpack Preview"]';
const DRAFT_BANNER = "Rascunho confirmado do agente. Build e aprovação visual ainda pendentes; a revisão salva permanece intacta.";

function appSource(title: string): string {
  return `export default function App() {\n  return (\n    <main style={{ padding: 24, fontFamily: "system-ui" }}>\n      <h1>${title}</h1>\n    </main>\n  );\n}\n`;
}

function makeFiles(title: string): WebsiteFiles {
  return {
    "src/App.tsx": appSource(title),
    ...getStarterFiles(),
    "src/App.tsx": appSource(title),
  };
}

function makeProject(overrides: Partial<WebsiteProject> = {}): WebsiteProject {
  return {
    id: PROJECT_ID,
    client_id: CLIENT_ID,
    name: "Projeto Teste",
    slug: "projeto-teste",
    lead_id: null,
    client_context: { name: "Empresa Teste" },
    instructions: "Landing page institucional",
    model_mode: "auto",
    model_id: null,
    selected_skill_ids: [],
    cta: { type: "whatsapp", value: "5511999999999" },
    status: "draft",
    current_revision_id: "rev-1",
    published_deployment_id: null,
    published_url: null,
    last_published_at: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function makeRun(id: string, status: WebsiteRun["status"], baseRevisionId: string | null = "rev-1"): WebsiteRun {
  return {
    id,
    client_id: CLIENT_ID,
    project_id: PROJECT_ID,
    kind: "agent",
    status,
    prompt: "Atualizar hero",
    model_id: null,
    base_revision_id: baseRevisionId,
    asset_ids: [],
    error: null,
    cancel_requested: false,
    lease_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeReadyBuild(revisionId: string): WebsiteBuild {
  return {
    id: `build-${revisionId}`,
    client_id: CLIENT_ID,
    project_id: PROJECT_ID,
    revision_id: revisionId,
    success: true,
    status: "ready",
    logs: "OK",
    duration_ms: 100,
    artifact: {},
    errors: [],
    warnings: [],
    screenshots: {},
    qa: { passed: true, errors: [], warnings: [] },
    created_at: NOW,
  };
}

function createState(overrides: Partial<EditorMockState> = {}): EditorMockState {
  return {
    project: makeProject(),
    files: makeFiles("Revisão salva"),
    runs: [],
    revisions: [],
    builds: [makeReadyBuild("rev-1")],
    deployments: [],
    messages: [],
    assets: [],
    models: [],
    skills: [],
    checkpoints: new Map(),
    checkpointNotModifiedCount: 0,
    sseConnections: 0,
    ...overrides,
  };
}

async function installEditorRoutes(page: Page, state: EditorMockState): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method().toUpperCase();

    if (pathname === "/api/auth/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, clientId: CLIENT_ID, actorId: ACTOR_ID }),
      });
      return;
    }

    if (pathname === "/api/sites/models") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: state.models }),
      });
      return;
    }

    if (pathname === "/api/sites/skills") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skills: state.skills }),
      });
      return;
    }

    const base = `/api/sites/${PROJECT_ID}`;
    if (pathname === base && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ project: state.project }),
      });
      return;
    }

    if (pathname === `${base}/files` && method === "GET") {
      const runId = url.searchParams.get("run_id");
      if (!runId) {
        const defaultRespond = async (): Promise<void> => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ files: state.files }),
          });
        };
        if (state.onCanonicalFilesRequest) {
          await state.onCanonicalFilesRequest(route, defaultRespond);
          return;
        }
        await defaultRespond();
        return;
      }

      const defaultRespond = async (): Promise<void> => {
        const entry = state.checkpoints.get(runId) ?? {
          etag: `"empty-${runId}"`,
          data: { checkpoint: null },
        };
        const ifNoneMatch = request.headers()["if-none-match"];
        if (ifNoneMatch && ifNoneMatch === entry.etag) {
          state.checkpointNotModifiedCount++;
          await route.fulfill({
            status: 304,
            headers: { ETag: entry.etag, "Cache-Control": "no-store" },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { ETag: entry.etag, "Cache-Control": "no-store" },
          body: JSON.stringify(entry.data),
        });
      };

      if (state.onCheckpointRequest) {
        await state.onCheckpointRequest(runId, route, defaultRespond);
        return;
      }
      await defaultRespond();
      return;
    }

    if (pathname === `${base}/files` && method === "PUT") {
      const payload = JSON.parse(request.postData() ?? "{}") as { files?: WebsiteFiles };
      if (payload.files) state.files = payload.files;
      const nextRevision = `rev-${state.revisions.length + 2}`;
      state.project = { ...state.project, current_revision_id: nextRevision };
      const revision: WebsiteRevision = {
        id: nextRevision,
        client_id: CLIENT_ID,
        project_id: PROJECT_ID,
        parent_id: "rev-1",
        message: "Edição manual",
        files: state.files,
        hash: nextRevision,
        created_at: NOW,
        actor_id: ACTOR_ID,
      };
      state.revisions = [revision, ...state.revisions];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: state.files, revisions: state.revisions }),
      });
      return;
    }

    if (pathname === `${base}/runs` && method === "GET") {
      const defaultRespond = async (): Promise<void> => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runs: state.runs }),
        });
      };
      if (state.onRunsRequest) {
        await state.onRunsRequest(route, defaultRespond);
        return;
      }
      await defaultRespond();
      return;
    }

    const cancelMatch = new RegExp(`^${base}/runs/([^/]+)/cancel$`).exec(pathname);
    if (cancelMatch && method === "POST") {
      const runId = decodeURIComponent(cancelMatch[1]);
      state.runs = state.runs.map((run) => (run.id === runId ? { ...run, status: "cancelled", cancel_requested: true } : run));
      state.checkpoints.set(runId, { etag: `"cancelled-${runId}"`, data: { checkpoint: null } });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: state.runs }),
      });
      return;
    }

    const sseMatch = new RegExp(`^${base}/runs/([^/]+)/activities$`).exec(pathname);
    if (sseMatch && method === "GET") {
      const runId = decodeURIComponent(sseMatch[1]);
      state.sseConnections++;
      if (state.onSseRequest) {
        await state.onSseRequest(runId, route);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "Cache-Control": "no-cache" },
        body: ": connected\n\n",
      });
      return;
    }

    if (pathname === `${base}/revisions` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revisions: state.revisions }) });
      return;
    }

    if (pathname === `${base}/builds` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ builds: state.builds }) });
      return;
    }

    if (pathname === `${base}/deployments` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: state.deployments }) });
      return;
    }

    if (pathname === `${base}/messages` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: state.messages }) });
      return;
    }

    if (pathname === `${base}/assets` && method === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ assets: state.assets }) });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: `Unhandled route: ${method} ${pathname}` }),
    });
  });
}

test.use({ viewport: { width: 1440, height: 1000 } });

const pageErrors = new WeakMap<Page, string[]>();
const mainNavigations = new WeakMap<Page, number>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  mainNavigations.set(page, 0);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      mainNavigations.set(page, (mainNavigations.get(page) ?? 0) + 1);
    }
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], "Real SiteProjectPage should not throw uncaught page errors").toEqual([]);
  expect(mainNavigations.get(page) ?? 0, "Real SiteProjectPage should stay mounted without full-page reloads").toBe(1);
});

test("polls confirmed checkpoint into Preview using ETag 304 without promoting to canonical Code tab", async ({ page }) => {
  const run = makeRun("run-poll-1", "editing", "rev-1");
  let publishCheckpoint = false;

  const state = createState({
    runs: [run],
    onRunsRequest: async (_route, defaultRespond) => {
      if (publishCheckpoint) {
        state.checkpoints.set(run.id, {
          etag: '"cp-v1"',
          data: {
            checkpoint: {
              version: "2",
              run_id: run.id,
              base_revision_id: "rev-1",
              files: makeFiles("Rascunho confirmado"),
            },
          },
        });
      }
      await defaultRespond();
    },
  });
  state.checkpoints.set(run.id, {
    etag: `"empty-${run.id}"`,
    data: { checkpoint: null },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 60_000 });

  publishCheckpoint = true;
  await expect(preview.getByRole("heading", { name: "Rascunho confirmado" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DRAFT_BANNER)).toBeVisible();

  await expect.poll(() => state.checkpointNotModifiedCount, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  await page.getByRole("tab", { name: "Código", exact: true }).click();
  await expect(page.locator("#site-file-content")).toBeVisible();
  await expect(page.locator("#site-file-content")).toHaveValue(/Revisão salva/);
});

test("preserves manual dirty draft in Code tab when delayed checkpoint response arrives", async ({ page }) => {
  const run1 = makeRun("run-done-1", "editing", "rev-1");
  const run2 = makeRun("run-failed-2", "failed", "rev-1");
  let allowComplete = false;
  let failReloadFilesOnce = false;
  let markDelayedInFlight!: () => void;
  let releaseDelayedCheckpoint!: () => void;
  const delayedInFlight = new Promise<void>((resolve) => {
    markDelayedInFlight = resolve;
  });
  const delayedGate = new Promise<void>((resolve) => {
    releaseDelayedCheckpoint = resolve;
  });
  let delayedCheckpointDelivered = false;

  const state = createState({
    runs: [run1],
    onRunsRequest: async (_route, defaultRespond) => {
      if (allowComplete && state.runs[0]?.id === run1.id) {
        state.runs = [{ ...run1, status: "completed" }];
      }
      await defaultRespond();
    },
    onCanonicalFilesRequest: async (route, defaultRespond) => {
      if (failReloadFilesOnce) {
        failReloadFilesOnce = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Falha temporária ao recarregar revisão." }),
        });
        return;
      }
      await defaultRespond();
    },
    onCheckpointRequest: async (runId, route, defaultRespond) => {
      if (runId === run2.id) {
        markDelayedInFlight();
        await delayedGate;
        delayedCheckpointDelivered = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { ETag: '"cp-late"', "Cache-Control": "no-store" },
          body: JSON.stringify({
            checkpoint: {
              version: "2",
              run_id: run2.id,
              base_revision_id: "rev-1",
              files: makeFiles("Rascunho atrasado"),
            },
          }),
        });
        return;
      }
      await defaultRespond();
    },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 60_000 });

  // Trigger a transient reload failure after run1 completes so "Recarregar projeto" renders with writable editor.
  failReloadFilesOnce = true;
  allowComplete = true;
  await expect(page.getByRole("button", { name: "Recarregar projeto", exact: true })).toBeVisible({ timeout: 15_000 });

  // Switch active candidate to a non-completed run whose checkpoint fetch stays in-flight while the operator edits Code.
  state.runs = [run2, { ...run1, status: "completed" }];
  await page.getByRole("button", { name: "Recarregar projeto", exact: true }).click();
  await delayedInFlight;

  await page.getByRole("tab", { name: "Código", exact: true }).click();
  const codeEditor = page.locator("#site-file-content");
  await expect(codeEditor).toBeVisible();
  await expect(codeEditor).toHaveJSProperty("readOnly", false, { timeout: 10_000 });

  const manualCode = appSource("Edição manual do operador");
  await codeEditor.fill(manualCode);

  await expect(page.getByText(/Salve ou descarte as alterações em Código e Ajustes antes de executar/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeDisabled();

  releaseDelayedCheckpoint();
  await expect.poll(() => delayedCheckpointDelivered, { timeout: 10_000 }).toBe(true);

  await expect(codeEditor).toHaveValue(manualCode);
  await expect(page.getByRole("button", { name: "Publicar", exact: true })).toBeDisabled();
  await expect(page.getByText(DRAFT_BANNER)).toHaveCount(0);

  await page.getByRole("tab", { name: "Prévia", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Rascunho atrasado" })).toHaveCount(0);
});

test("discards checkpoints with mismatched run_id or stale base_revision_id without leaving stale preview", async ({ page }) => {
  const run1 = makeRun("run-valid-1", "editing", "rev-1");
  const run2 = makeRun("run-mismatch-2", "editing", "rev-1");
  let phase: "valid" | "wrong-run" | "wrong-revision" = "valid";
  let wrongRevisionResponses = 0;

  const state = createState({
    runs: [run1],
    onRunsRequest: async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: phase === "valid" ? [run1] : [run2, { ...run1, status: "failed" }],
        }),
      });
    },
    onCheckpointRequest: async (runId, _route, defaultRespond) => {
      if (runId === run2.id && phase === "wrong-revision") {
        wrongRevisionResponses++;
      }
      await defaultRespond();
    },
  });
  state.checkpoints.set(run1.id, {
    etag: '"cp-valid-1"',
    data: {
      checkpoint: {
        version: "2",
        run_id: run1.id,
        base_revision_id: "rev-1",
        files: makeFiles("Checkpoint válido"),
      },
    },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Checkpoint válido" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(DRAFT_BANNER)).toBeVisible();

  phase = "wrong-run";
  state.checkpoints.set(run2.id, {
    etag: '"cp-wrong-run"',
    data: {
      checkpoint: {
        version: "2",
        run_id: "run-outro",
        base_revision_id: "rev-1",
        files: makeFiles("Run incorreta"),
      },
    },
  });

  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DRAFT_BANNER)).toHaveCount(0);

  phase = "wrong-revision";
  state.checkpoints.set(run2.id, {
    etag: '"cp-wrong-rev"',
    data: {
      checkpoint: {
        version: "2",
        run_id: run2.id,
        base_revision_id: "rev-antiga",
        files: makeFiles("Revisão obsoleta"),
      },
    },
  });

  await expect.poll(() => wrongRevisionResponses, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Revisão obsoleta" })).toHaveCount(0);
});

test("applies SSE file_written checkpoint immediately and keeps single EventSource across polls", async ({ page }) => {
  const run = makeRun("run-sse-1", "editing", "rev-1");
  let releaseSseEvent!: () => void;
  const sseEventGate = new Promise<void>((resolve) => {
    releaseSseEvent = resolve;
  });
  let pollsObserved = 0;

  const state = createState({
    runs: [run],
    onRunsRequest: async (route) => {
      pollsObserved++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: [{ ...run, updated_at: `2026-10-08T12:00:0${Math.min(pollsObserved, 9)}.000Z` }],
        }),
      });
    },
    onSseRequest: async (_runId, route) => {
      await sseEventGate;
      state.checkpoints.set(run.id, {
        etag: '"cp-sse-1"',
        data: {
          checkpoint: {
            version: "2",
            run_id: run.id,
            base_revision_id: "rev-1",
            files: makeFiles("Atualizado via SSE"),
          },
        },
      });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "Cache-Control": "no-cache" },
        body: `data: ${JSON.stringify({ type: "file_written", status: "completed", details: { path: "src/App.tsx" } })}\n\n`,
      });
    },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 60_000 });

  await expect.poll(() => pollsObserved, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  expect(state.sseConnections, "EventSource should not reconnect on every poll when activeRunId is unchanged").toBe(1);

  releaseSseEvent();
  await expect(preview.getByRole("heading", { name: "Atualizado via SSE" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DRAFT_BANNER)).toBeVisible();
});

test("reloads canonical project and files when active run completes", async ({ page }) => {
  const run = makeRun("run-complete-1", "editing", "rev-1");
  let completeNow = false;

  const state = createState({
    runs: [run],
    onRunsRequest: async (_route, defaultRespond) => {
      if (completeNow) {
        state.project = makeProject({ current_revision_id: "rev-2" });
        state.files = makeFiles("Revisão concluída");
        state.builds = [makeReadyBuild("rev-2")];
        state.runs = [{ ...run, status: "completed" }];
      }
      await defaultRespond();
    },
  });
  state.checkpoints.set(run.id, {
    etag: '"cp-before-complete"',
    data: {
      checkpoint: {
        version: "2",
        run_id: run.id,
        base_revision_id: "rev-1",
        files: makeFiles("Rascunho antes de concluir"),
      },
    },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Rascunho antes de concluir" })).toBeVisible({ timeout: 60_000 });

  completeNow = true;
  await expect(preview.getByRole("heading", { name: "Revisão concluída" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DRAFT_BANNER)).toHaveCount(0);

  await page.getByRole("tab", { name: "Código", exact: true }).click();
  await expect(page.locator("#site-file-content")).toHaveValue(/Revisão concluída/);
});

test("clears confirmed checkpoint preview back to canonical revision when run is cancelled", async ({ page }) => {
  const run = makeRun("run-cancel-1", "editing", "rev-1");
  const state = createState({
    runs: [run],
  });
  state.checkpoints.set(run.id, {
    etag: '"cp-abort-1"',
    data: {
      checkpoint: {
        version: "2",
        run_id: run.id,
        base_revision_id: "rev-1",
        files: makeFiles("Rascunho abortado"),
      },
    },
  });

  await installEditorRoutes(page, state);
  await page.goto("/");

  const preview = page.frameLocator(ACCEPTED_PREVIEW_IFRAME);
  await expect(preview.getByRole("heading", { name: "Rascunho abortado" })).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Cancelar", exact: true }).click();

  await expect(preview.getByRole("heading", { name: "Revisão salva" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(DRAFT_BANNER)).toHaveCount(0);
});
