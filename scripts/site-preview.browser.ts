import { expect, test, type Page } from "@playwright/test";

const operatorLifecycle = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const lifecycle: string[] = [];
  operatorLifecycle.set(page, lifecycle);
  page.on("framenavigated", frame => {
    lifecycle.push(frame === page.mainFrame() ? "operator:navigated" : "preview:navigated");
  });
  page.on("websocket", socket => {
    if (new URL(socket.url()).hostname !== "127.0.0.1") return;
    socket.on("framereceived", ({ payload }) => {
      try {
        const data: unknown = JSON.parse(String(payload));
        if (data && typeof data === "object" && "type" in data && ["full-reload", "update", "connected", "error"].includes(String(data.type))) {
          lifecycle.push(`vite:${data.type}`);
        }
      } catch { /* Non-JSON websocket frames carry no lifecycle evidence. */ }
    });
  });
  page.on("pageerror", () => lifecycle.push("operator:error"));
  await page.exposeBinding("__recordPreviewLifecycle", (_source, value: unknown) => {
    if (typeof value !== "string" || !/^(?:start|done|success|show-error|status:(?:installing-dependencies|transpiling|evaluating|idle|unknown))$/.test(value)) return;
    if (lifecycle.length < 200) lifecycle.push(`sandpack:${value}`);
  });
  await page.addInitScript(() => {
    window.addEventListener("message", event => {
      if (!event.data || typeof event.data !== "object") return;
      const { type, status } = event.data;
      if (typeof type !== "string" || !/^(?:start|status|done|success|show-error)$/.test(type)) return;
      const known = ["installing-dependencies", "transpiling", "evaluating", "idle"].includes(status) ? status : "unknown";
      void Reflect.get(window, "__recordPreviewLifecycle")(type === "status" ? `status:${known}` : type);
    });
  });
});

test.afterEach(async ({ page }, info) => {
  const lifecycle = operatorLifecycle.get(page) ?? [];
  const navigations = lifecycle.filter(event => event === "operator:navigated").length;
  if (info.status !== info.expectedStatus || navigations !== 1) {
    await info.attach("preview-lifecycle", { body: JSON.stringify({ lifecycle }), contentType: "application/json" });
  }
  expect(navigations, "O operador não deve recarregar durante a jornada").toBe(1);
});

for (const failure of [
  { button: "Falhar renderização", message: "Render sintético falhou" },
  { button: "Falhar efeito", message: "Efeito sintético falhou" },
]) {
  test(`observes native last-render behavior after ${failure.button}`, async ({ page }) => {
    await page.goto("/");
    const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
    await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: failure.button, exact: true }).click();
    await expect(page.getByRole("button", { name: failure.button, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("alert")).toContainText(failure.message, { timeout: 30_000 });
    await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restaurar fontes" })).toBeVisible();
  });

  test(`recovers from ${failure.button} without a stale diagnostic or iframe remount`, async ({ page }) => {
    await page.goto("/");
    const iframe = page.locator('iframe[title="Sandpack Preview"]');
    const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
    await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-preview-state="accepted"] iframe')).toHaveCount(1);
    const initialSrc = await iframe.getAttribute("src");
    const initialIframe = await iframe.elementHandle();
    if (!initialIframe) throw new Error("Iframe inicial ausente");
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: failure.button, exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(failure.message, { timeout: 30_000 });
      await page.getByRole("button", { name: "Restaurar fontes" }).click();
      await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(preview.getByRole("alert")).toHaveCount(0);
      await expect(iframe).toHaveAttribute("src", initialSrc!);
      expect(await iframe.evaluate((current, original) => original.isConnected && current === original, initialIframe)).toBe(true);
    }
    await initialIframe.dispose();
  });
}

for (const initial of ["render", "syntax"]) {
  test(`shows an explicit error for an invalid first ${initial} and recovers`, async ({ page }) => {
    await page.goto(`/?initial=${initial}`);
    const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
    if (initial === "render") {
      await expect(page.getByRole("alert")).toContainText("Render sintético falhou", { timeout: 60_000 });
    } else {
      await expect(page.getByRole("alert")).toContainText("Não foi possível carregar", { timeout: 60_000 });
    }
    await expect(preview.getByRole("heading", { name: "Campo A" })).toHaveCount(0);
    await page.getByRole("button", { name: "Restaurar fontes" }).click();
    await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(preview.getByRole("alert")).toHaveCount(0);
  });
}

test("renders an isolated React preview and applies a same-length edit", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message.slice(0, 500)));
  await page.goto("/");
  try { await expect(page.getByRole("button", { name: "Texto mesmo tamanho" })).toBeVisible({ timeout: 15_000 }); }
  catch { throw new Error(`Fixture não montou: ${errors.join("; ")}`); }
  const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-preview-state="accepted"] iframe')).toHaveCount(1);
  const initialSrc = await page.locator('iframe[title="Sandpack Preview"]').getAttribute("src");
  expect(new URL(initialSrc!).origin).not.toBe("http://127.0.0.1:4178");
  await page.getByRole("button", { name: "Texto mesmo tamanho" }).click();
  const acceptedPreview = page.frameLocator('[data-preview-state="accepted"] iframe[title="Sandpack Preview"]');
  await expect(acceptedPreview.getByRole("heading", { name: "Campo B" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-preview-state="accepted"] iframe')).toHaveCount(1);
  await expect(page.locator('[data-preview-state="pending"]')).toHaveCount(0);
});

test("promotes the existing candidate iframe and its state without remounting", async ({ page }) => {
  await page.goto("/");
  const accepted = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(accepted.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const hold = (event: MessageEvent) => {
      if (event.data?.type !== "preview-candidate" || event.data.status !== "ready") return;
      event.stopImmediatePropagation();
      Reflect.set(window, "__heldCandidate", { data: event.data, origin: event.origin, source: event.source });
    };
    window.addEventListener("message", hold, true);
    Reflect.set(window, "__releaseCandidate", () => {
      window.removeEventListener("message", hold, true);
      const held = Reflect.get(window, "__heldCandidate");
      if (!held) throw new Error("Sonda de candidato não recebida");
      window.dispatchEvent(new MessageEvent("message", held));
    });
  });
  await page.getByRole("button", { name: "Texto mesmo tamanho" }).click();
  const pendingIframe = page.locator('[data-preview-state="pending"] iframe');
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__heldCandidate"))), { timeout: 30_000 }).toBe(true);
  const pending = await pendingIframe.elementHandle();
  if (!pending) throw new Error("Candidato ausente");
  await page.frameLocator('[data-preview-state="pending"] iframe').locator("html").evaluate(() => Reflect.set(window, "__candidateState", "preservado"));
  await page.evaluate(() => Reflect.get(window, "__releaseCandidate")());
  await expect(accepted.getByRole("heading", { name: "Campo B" })).toBeVisible({ timeout: 30_000 });
  expect(await page.locator('[data-preview-state="accepted"] iframe').evaluate((current, original) => original.isConnected && current === original, pending)).toBe(true);
  expect(await accepted.locator("html").evaluate(() => Reflect.get(window, "__candidateState"))).toBe("preservado");
  await pending.dispose();
});

test("rejects stale and malformed readiness messages while preserving the accepted preview", async ({ page }) => {
  await page.goto("/");
  const accepted = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(accepted.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const hold = (event: MessageEvent) => {
      if (event.data?.type !== "preview-candidate" || event.data.status !== "ready") return;
      event.stopImmediatePropagation();
      Reflect.set(window, "__heldCandidate", { data: event.data, origin: event.origin, source: event.source });
    };
    window.addEventListener("message", hold, true);
    Reflect.set(window, "__stopHoldingCandidate", () => window.removeEventListener("message", hold, true));
  });
  await page.getByRole("button", { name: "Texto mesmo tamanho" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__heldCandidate"))), { timeout: 30_000 }).toBe(true);
  const pending = await page.locator('[data-preview-state="pending"] iframe').elementHandle();
  if (!pending) throw new Error("Candidato ausente");
  await page.evaluate(() => {
    const held = Reflect.get(window, "__heldCandidate");
    window.dispatchEvent(new MessageEvent("message", { ...held, data: { ...held.data, status: ["failed"] } }));
  });
  await expect(page.locator('[data-preview-state="pending"] iframe')).toHaveCount(1);
  expect(await page.locator('[data-preview-state="pending"] iframe').evaluate((current, original) => original.isConnected && current === original, pending)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await pending.dispose();
  await expect(accepted.getByRole("heading", { name: "Campo A" })).toBeVisible();
  await page.getByRole("button", { name: "Falhar renderização", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Render sintético falhou", { timeout: 30_000 });
  await page.evaluate(() => {
    Reflect.get(window, "__stopHoldingCandidate")();
    const held = Reflect.get(window, "__heldCandidate");
    window.dispatchEvent(new MessageEvent("message", held));
  });
  await expect(accepted.getByRole("heading", { name: "Campo A" })).toBeVisible();
  await expect(page.locator('[data-preview-state="pending"]')).toHaveCount(0);
});

test("keeps bootstrap markers inside HTML as data", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "HTML com marcador", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Marcador literal preservado" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("preserves accepted content when HTML preparation fails", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "HTML inválido", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fontes inválidas");
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
});

test("does not promote compiler success without a React commit and disposes the timed-out candidate", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.clock.install();
  await page.getByRole("button", { name: "Entry sem montagem", exact: true }).click();
  await expect(page.locator('[data-preview-state="pending"] iframe')).toHaveCount(1);
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
  await page.clock.fastForward(60_001);
  await expect(page.getByRole("alert")).toContainText("Não foi possível confirmar a montagem inicial");
  await expect(page.locator('[data-preview-state="pending"]')).toHaveCount(0);
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
});

test("renders local JSON, CSS and SVG imports in the isolated candidate", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "JSON CSS SVG", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Conteúdo JSON" })).toBeVisible({ timeout: 30_000 });
  const image = preview.getByRole("img", { name: "Símbolo agrícola" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(80);
  await expect(preview.getByText("CSS carregado")).toHaveCSS("color", "rgb(22, 101, 52)");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("retains the accepted iframe when the next checkpoint is incomplete", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  const initial = await page.locator('[data-preview-state="accepted"] iframe').elementHandle();
  if (!initial) throw new Error("Iframe ausente");
  await page.getByRole("button", { name: "Rascunho incompleto", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Rascunho incompleto");
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
  expect(await page.locator('[data-preview-state="accepted"] iframe').evaluate((current, original) => original.isConnected && current === original, initial)).toBe(true);
  await initial.dispose();
});

test("promotes a recovered Error Boundary without a fatal diagnostic", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('[data-preview-state="accepted"] iframe');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Erro tratado", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Fallback recuperado" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(preview.getByRole("alert")).toHaveCount(0);
});

test("retains the last rendered preview while a candidate has a syntax error", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Quebrar sintaxe" }).click();
  await expect(page.getByRole("alert")).toContainText("Não foi possível carregar", { timeout: 30_000 });
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible();
  await page.getByRole("button", { name: "Restaurar fontes" }).click();
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("renders tablet and mobile viewports without horizontal page overflow", async ({ page }) => {
  await page.goto("/");
  const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  const initialIframe = await page.locator('iframe[title="Sandpack Preview"]').elementHandle();
  if (!initialIframe) throw new Error("Iframe inicial ausente");
  await page.getByRole("button", { name: "Tablet 768 pixels" }).click();
  await expect(page.getByRole("button", { name: "Tablet 768 pixels" })).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => preview.locator("html").evaluate(() => window.innerWidth)).toBe(768);
  expect(await page.locator('iframe[title="Sandpack Preview"]').evaluate((current, original) => original.isConnected && current === original, initialIframe)).toBe(true);
  expect(await preview.locator("html").evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Mobile 390 pixels" }).click();
  await expect(page.getByRole("button", { name: "Mobile 390 pixels" })).toHaveAttribute("aria-pressed", "true");
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => preview.locator("html").evaluate(() => window.innerWidth)).toBe(390);
  expect(await page.locator('iframe[title="Sandpack Preview"]').evaluate((current, original) => original.isConnected && current === original, initialIframe)).toBe(true);
  expect(await preview.locator("html").evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole("button", { name: "Tablet 768 pixels" }).click();
  await page.getByRole("button", { name: "100%", exact: true }).click();
  const geometry = await page.locator('iframe[title="Sandpack Preview"]').evaluate(iframe => {
    const clipped = [];
    for (let node = iframe.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") break;
      if (overflow === "hidden") clipped.push(node.getBoundingClientRect().width);
    }
    return { frameWidth: iframe.getBoundingClientRect().width, screenWidth: Math.min(...clipped) };
  });
  expect(geometry.screenWidth).toBeGreaterThanOrEqual(geometry.frameWidth);
  await initialIframe.dispose();
});

test("shows asynchronous failures without losing the operator UI", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "100%", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 60_000 });
  await preview.getByRole("button", { name: "Falhar evento" }).focus();
  await preview.getByRole("button", { name: "Falhar evento" }).press("Enter");
  await expect(preview.getByRole("button", { name: "Evento disparado" })).toBeVisible();
  await expect(preview.getByRole("alert")).toContainText("Evento sintético falhou");
  await page.getByRole("button", { name: "Recarregar", exact: true }).click();
  await expect(page.locator('[data-preview-state="pending"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(preview.getByRole("alert")).toHaveCount(0);
  await expect(preview.getByRole("heading", { name: "Campo A" })).toBeVisible({ timeout: 30_000 });
  await preview.getByRole("button", { name: "Falhar promessa" }).focus();
  await preview.getByRole("button", { name: "Falhar promessa" }).press("Enter");
  await expect(preview.getByRole("button", { name: "Promessa disparada" })).toBeVisible();
  await expect(preview.getByRole("alert")).toContainText("Promessa sintética falhou");
  await expect(page.getByRole("button", { name: "Restaurar fontes" })).toBeVisible();
});
