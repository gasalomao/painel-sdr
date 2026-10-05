import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsiteAsset } from "../types";

const state = vi.hoisted(() => ({
  rows: [] as WebsiteAsset[],
  filters: [] as unknown[][],
  queue: [] as Array<{ data?: unknown; error?: unknown }>,
  updates: [] as unknown[],
  inserts: [] as unknown[],
  rpc: vi.fn(),
  project: vi.fn(),
  sign: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  dequeue: (eqFilters?: Array<[string, unknown]>, single = false) => {
    const queued = state.queue.shift();
    if (queued) return queued;
    const rows = eqFilters?.length
      ? state.rows.filter((row) => eqFilters.every(([key, value]) => (Array.isArray(value) ? value.includes((row as unknown as Record<string, unknown>)[key]) : (row as unknown as Record<string, unknown>)[key] === value)))
      : state.rows;
    return { data: single ? rows[0] ?? null : rows, error: null };
  },
}));
vi.mock("../repository", () => ({ getProject: state.project }));
vi.mock("../server", () => ({
  getSitesDb: () => ({
    rpc: state.rpc,
    from: () => {
      const eqFilters: Array<[string, unknown]> = [];
      let patch: Partial<WebsiteAsset> | undefined;
      let deleting = false;
      const execute = (single = false) => {
        if (state.queue.length) return state.dequeue(eqFilters, single);
        const rows = state.rows.filter((row) => eqFilters.every(([key, value]) => {
          const actual = (row as unknown as Record<string, unknown>)[key];
          return Array.isArray(value) ? value.includes(actual) : actual === value;
        }));
        if (patch) rows.forEach((row) => Object.assign(row, patch));
        if (deleting) state.rows = state.rows.filter((row) => !rows.includes(row));
        return { data: single ? rows[0] ? { ...rows[0] } : null : rows.map((row) => ({ ...row })), error: null };
      };
      const chain = {
        select: vi.fn(() => chain),
        insert: vi.fn((value: unknown) => { state.inserts.push(value); return chain; }),
        update: vi.fn((value: Partial<WebsiteAsset>) => { patch = value; state.updates.push(value); return chain; }),
        delete: vi.fn(() => { deleting = true; return chain; }),
        eq: vi.fn((key: string, value: unknown) => { eqFilters.push([key, value]); state.filters.push([key, value]); return chain; }),
        in: vi.fn((key: string, value: unknown) => { eqFilters.push([key, value]); state.filters.push([key, value]); return chain; }),
        order: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(execute())),
        single: vi.fn(() => Promise.resolve(execute(true))),
        maybeSingle: vi.fn(() => Promise.resolve(execute(true))),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { storage: { from: vi.fn(() => ({ createSignedUrl: state.sign, remove: state.remove, upload: state.upload })) } } }));

import { deleteWebsiteAsset, getReferencedAssets, getSelectedAssets, listWebsiteAssets, MAX_WEBSITE_ASSET_BYTES, parseWebsiteUpload, uploadWebsiteAsset, validateWebsiteImage, websiteAssetPath } from "../assets";

const clientId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=", "base64");
const asset: WebsiteAsset = { id: assetId, client_id: clientId, project_id: projectId, name: "logo.png", path: `${clientId}/${projectId}/${assetId}.png`, mime: "image/png", size: png.length, width: 1, height: 1, purpose: "logo", status: "ready", created_at: "2026-09-17T00:00:00Z" };

function uploadRequest(file: Blob, purpose = "logo", license = true): Request {
  const form = new FormData();
  form.set("file", file);
  form.set("purpose", purpose);
  if (license) form.set("license_confirmed", "true");
  return new Request(`https://app.example.test/api/sites/${projectId}/assets`, { method: "POST", headers: { origin: "https://app.example.test" }, body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [{ ...asset }]; state.filters = []; state.queue = []; state.updates = [];
  state.project.mockResolvedValue({ id: projectId, client_id: clientId });
  state.sign.mockResolvedValue({ data: { signedUrl: "https://storage.example.test/signed?token=temporary" }, error: null });
  state.rpc.mockResolvedValue({ data: null, error: null });
  state.upload.mockResolvedValue({ data: { path: "ok" }, error: null });
  state.remove.mockResolvedValue({ data: null, error: null });
});

describe("website assets", () => {
  it("reads PNG magic and dimensions without trusting extension", () => {
    expect(validateWebsiteImage(png, "image/png")).toEqual({ mime: "image/png", extension: "png", width: 1, height: 1 });
    expect(() => validateWebsiteImage(png, "image/jpeg")).toThrow();
  });

  it.each(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "<!DOCTYPE svg><svg/>", "<svg><image href='http://localhost'/></svg>", "<html>fake</html>"])("rejects SVG and executable or disguised content with an explicit SVG message", (input) => {
    expect(() => validateWebsiteImage(Buffer.from(input), "image/svg+xml")).toThrow(/SVG/);
    expect(() => validateWebsiteImage(Buffer.from(input), "image/png")).toThrow();
  });

  it("reports rejected SVG at upload parsing with a clear message", async () => {
    await expect(parseWebsiteUpload(uploadRequest(new File([Buffer.from("<svg/>")], "logo.svg", { type: "image/svg+xml" })))).rejects.toThrow(/SVG não é aceito/);
  });

  it("rejects truncated, oversized and trailing payloads", () => {
    expect(() => validateWebsiteImage(png.subarray(0, 24), "image/png")).toThrow();
    expect(() => validateWebsiteImage(Buffer.alloc(MAX_WEBSITE_ASSET_BYTES + 1), "image/png")).toThrow();
    expect(() => validateWebsiteImage(Buffer.concat([png, Buffer.from("<script/>")]), "image/png")).toThrow();
    const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16);
    expect(() => validateWebsiteImage(huge, "image/png")).toThrow();
  });

  it("uses only generated tenant/project/asset UUID paths", () => {
    expect(websiteAssetPath(clientId, projectId, assetId, "image/png")).toBe(asset.path);
    expect(() => websiteAssetPath("../tenant", projectId, assetId, "image/png")).toThrow();
    expect(() => websiteAssetPath(clientId, projectId, assetId, "image/svg+xml")).toThrow();
  });

  it("signs only authorized selected assets with a short expiry", async () => {
    const selected = await getSelectedAssets(clientId, projectId, [assetId]);
    expect(selected[0].url).toContain("token=temporary");
    expect(state.project).toHaveBeenCalledWith(clientId, projectId);
    expect(state.filters).toContainEqual(["client_id", clientId]);
    expect(state.filters).toContainEqual(["project_id", projectId]);
    expect(state.filters).toContainEqual(["id", [assetId]]);
    expect(state.sign).toHaveBeenCalledWith(asset.path, 300);
  });

  it("lists assets signing only ready ones so pending and failed statuses surface to the UI", async () => {
    const pending: WebsiteAsset = { ...asset, id: "99999999-9999-4999-8999-999999999999", status: "pending" };
    state.rows = [pending, asset];
    const listed = await listWebsiteAssets(clientId, projectId);
    expect(listed.find((item) => item.id === pending.id)?.status).toBe("pending");
    expect(listed.find((item) => item.id === pending.id)?.url).toBeUndefined();
    expect(listed.find((item) => item.id === asset.id)?.url).toContain("token=temporary");
    expect(state.sign).toHaveBeenCalledTimes(1);
    expect(state.sign).toHaveBeenCalledWith(asset.path, 300);
  });

  it("fails closed for missing, foreign, path-poisoned, non-ready or too many assets", async () => {
    state.rows = [];
    await expect(getSelectedAssets(clientId, projectId, [assetId])).rejects.toThrow();
    state.rows = [{ ...asset, client_id: projectId }];
    await expect(getSelectedAssets(clientId, projectId, [assetId])).rejects.toThrow();
    state.rows = [{ ...asset, path: "https://evil.test/image.png" }];
    await expect(getSelectedAssets(clientId, projectId, [assetId])).rejects.toThrow();
    state.rows = [{ ...asset, status: "pending" }];
    await expect(getSelectedAssets(clientId, projectId, [assetId])).rejects.toThrow();
    await expect(getSelectedAssets(clientId, projectId, Array(21).fill(assetId))).rejects.toThrow();
    expect(state.sign).not.toHaveBeenCalled();
  });

  it("requires same-origin upload and explicit license confirmation", async () => {
    await expect(parseWebsiteUpload(uploadRequest(new File([png], "logo.png", { type: "image/png" }), "logo", false))).rejects.toThrow(/licença/i);
    expect((await parseWebsiteUpload(uploadRequest(new File([png], "logo.png", { type: "image/png" })))).purpose).toBe("logo");
    const form = new FormData();
    form.set("file", new File([png], "logo.png", { type: "image/png" }));
    form.set("purpose", "logo");
    form.set("license_confirmed", "true");
    await expect(parseWebsiteUpload(new Request(`https://app.example.test/api/sites/${projectId}/assets`, { method: "POST", headers: { origin: "https://evil.test" }, body: form }))).rejects.toThrow();
  });

  it("enforces streaming body limits without content-length", async () => {
    const request = new Request(`https://app.example.test/api/sites/${projectId}/assets`, { method: "POST", headers: { origin: "https://app.example.test", "content-type": "multipart/form-data; boundary=x" }, body: new Uint8Array(MAX_WEBSITE_ASSET_BYTES + 65537) });
    await expect(parseWebsiteUpload(request)).rejects.toThrow(/limite/i);
  });

  it("reserves quota atomically via DB helper before touching storage", async () => {
    const upload = await parseWebsiteUpload(uploadRequest(new File([png], "logo.png", { type: "image/png" })));
    state.rpc.mockResolvedValue({ data: { id: "reserved" }, error: null });
    state.queue.push({ data: { ...asset, status: "ready" }, error: null });
    const created = await uploadWebsiteAsset(clientId, projectId, upload, actorId);
    expect(state.rpc).toHaveBeenCalledWith("website_reserve_asset", expect.objectContaining({ p_client_id: clientId, p_project_id: projectId, p_actor_id: actorId }));
    expect(((state.rpc.mock.calls[0] as unknown[])[1] as { p_asset: Record<string, unknown> }).p_asset).toMatchObject({ purpose: "logo", status: "pending" });
    expect(state.upload).toHaveBeenCalledTimes(1);
    expect(state.updates.at(-1)).toMatchObject({ status: "ready" });
    expect(created.url).toContain("token=temporary");
  });

  it("never touches storage when the reservation is refused", async () => {
    const upload = await parseWebsiteUpload(uploadRequest(new File([png], "logo.png", { type: "image/png" })));
    state.rpc.mockResolvedValue({ data: null, error: { message: "quota" } });
    await expect(uploadWebsiteAsset(clientId, projectId, upload, actorId)).rejects.toThrow(/reservar/i);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("marks the asset as failed when storage rejects the bytes", async () => {
    const upload = await parseWebsiteUpload(uploadRequest(new File([png], "logo.png", { type: "image/png" })));
    state.rpc.mockResolvedValue({ data: { id: "reserved" }, error: null });
    state.upload.mockResolvedValue({ data: null, error: { message: "storage" } });
    state.queue.push({ data: { id: assetId }, error: null });
    await expect(uploadWebsiteAsset(clientId, projectId, upload, actorId)).rejects.toThrow(/armazenar/i);
    expect(state.updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("resolves prior source assets without signing or selecting vision attachments", async () => {
    const files = { "src/App.tsx": `<img src="/assets/${assetId}.png"/>`, "src/style.css": `a{background:url(/assets/${assetId}.png)}` };
    expect(await getReferencedAssets(clientId, projectId, files)).toEqual([asset]);
    expect(state.filters).toContainEqual(["client_id", clientId]);
    expect(state.filters).toContainEqual(["project_id", projectId]);
    expect(state.filters).toContainEqual(["status", "ready"]);
    expect(state.filters).toContainEqual(["purpose", ["logo", "content"]]);
    expect(state.sign).not.toHaveBeenCalled();
  });

  it.each([
    { purpose: "reference" }, { status: "pending" }, { status: "failed" }, { status: "deleting" },
    { client_id: actorId }, { project_id: actorId }, { path: `${clientId}/${projectId}/${actorId}.png` },
    { mime: "image/jpeg", path: `${clientId}/${projectId}/${assetId}.jpg` },
  ] as Partial<WebsiteAsset>[]) ("rejects unavailable or mismatched source assets: %j", async (patch) => {
    state.rows = [{ ...asset, ...patch }];
    await expect(getReferencedAssets(clientId, projectId, { "src/App.tsx": `"/assets/${assetId}.png"` })).rejects.toThrow();
    expect(state.sign).not.toHaveBeenCalled();
  });

  it("rejects missing references and database failures", async () => {
    state.rows = [];
    await expect(getReferencedAssets(clientId, projectId, { "src/App.tsx": `"/assets/${assetId}.png"` })).rejects.toThrow();
    state.queue.push({ error: { message: "private detail" } });
    await expect(getReferencedAssets(clientId, projectId, { "src/App.tsx": `"/assets/${assetId}.png"` })).rejects.toThrow(/carregar/i);
    expect(await getReferencedAssets(clientId, projectId, { "src/App.tsx": "text" })).toEqual([]);
  });

  it("marks deleting before storage and makes completed deletion idempotent", async () => {
    state.remove.mockImplementation(async () => {
      expect(state.rows[0].status).toBe("deleting");
      return { error: null };
    });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).resolves.toBeUndefined();
    expect(state.updates).toEqual([{ status: "deleting" }]);
    expect(state.remove).toHaveBeenCalledWith([asset.path]);
    expect(state.rows).toEqual([]);
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).resolves.toBeUndefined();
    expect(state.remove).toHaveBeenCalledTimes(1);
  });

  it("resumes deleting after storage failure without restoring ready", async () => {
    state.remove.mockResolvedValueOnce({ error: { message: "storage offline" } });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).rejects.toThrow(/Tente novamente/);
    expect(state.rows[0].status).toBe("deleting");
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).resolves.toBeUndefined();
    expect(state.rows).toEqual([]);
    expect(state.remove).toHaveBeenCalledTimes(2);
  });

  it("resumes after row deletion fails and storage is already empty", async () => {
    state.remove.mockImplementationOnce(async () => {
      state.queue.push({ error: { message: "db offline" } });
      return { error: null };
    });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).rejects.toThrow(/limpeza/);
    expect(state.rows[0].status).toBe("deleting");
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).resolves.toBeUndefined();
    expect(state.rows).toEqual([]);
  });

  it("allows concurrent idempotent removals of the same immutable path", async () => {
    await expect(Promise.all([
      deleteWebsiteAsset(clientId, projectId, assetId),
      deleteWebsiteAsset(clientId, projectId, assetId),
    ])).resolves.toEqual([undefined, undefined]);
    expect(state.rows).toEqual([]);
    for (const [paths] of state.remove.mock.calls) expect(paths).toEqual([asset.path]);
  });

  it("does not touch storage when marking fails or a concurrent state change wins", async () => {
    state.queue.push({ data: asset }, { error: { message: "db offline" } });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).rejects.toThrow();
    state.queue.push({ data: asset }, { data: null });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).rejects.toThrow();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it.each([
    { client_id: actorId }, { project_id: actorId }, { path: `${clientId}/${projectId}/${actorId}.png` },
  ])("does not remove poisoned or foreign deleting rows: %j", async (patch) => {
    state.queue.push({ data: { ...asset, status: "deleting", ...patch } });
    await expect(deleteWebsiteAsset(clientId, projectId, assetId)).rejects.toThrow();
    expect(state.remove).not.toHaveBeenCalled();
  });
});
