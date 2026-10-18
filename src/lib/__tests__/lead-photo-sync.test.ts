import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncLeadPhotosSequentially, SyncBatchResponse } from "../lead-photo-sync";

const mockFetch = vi.fn();

function makeResponse(body: unknown, status = 200, ok = true): Response {
  return {
    status,
    ok,
    json: async () => body,
  } as Response;
}

describe("lead-photo-sync orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sincroniza lotes sequencialmente respeitando snapshot de upperId e acumulando progresso", async () => {
    const batch1: SyncBatchResponse = {
      success: true,
      partial: false,
      instance: "inst-1",
      processed: 40,
      updated: 10,
      noPhoto: 20,
      skipped: 10,
      failed: 0,
      total: 100,
      upperId: 999,
      nextCursor: 40,
      avatars: { "5511999990001@s.whatsapp.net": "https://img.wa/1.jpg" },
    };

    const batch2: SyncBatchResponse = {
      success: true,
      partial: false,
      instance: "inst-1",
      processed: 40,
      updated: 15,
      noPhoto: 15,
      skipped: 10,
      failed: 0,
      total: 100,
      upperId: 999,
      nextCursor: 80,
      avatars: { "5511999990002@s.whatsapp.net": "https://img.wa/2.jpg" },
    };

    const batch3: SyncBatchResponse = {
      success: true,
      partial: false,
      instance: "inst-1",
      processed: 20,
      updated: 5,
      noPhoto: 10,
      skipped: 5,
      failed: 0,
      total: 100,
      upperId: 999,
      nextCursor: null,
      avatars: { "5511999990003@s.whatsapp.net": null },
    };

    mockFetch
      .mockResolvedValueOnce(makeResponse(batch1))
      .mockResolvedValueOnce(makeResponse(batch2))
      .mockResolvedValueOnce(makeResponse(batch3));

    const progressReports: number[] = [];
    const receivedAvatars: Record<string, string | null>[] = [];

    const result = await syncLeadPhotosSequentially({
      instance: "inst-1",
      onProgress: (state) => progressReports.push(state.processed),
      onBatchAvatars: (avatars) => receivedAvatars.push(avatars),
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Call 1
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "/api/contacts/sync-avatars",
      expect.objectContaining({
        body: JSON.stringify({ scope: "leads", cursor: 0, instance: "inst-1" }),
      })
    );

    // Call 2 has upperId from batch 1 and cursor 40
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "/api/contacts/sync-avatars",
      expect.objectContaining({
        body: JSON.stringify({ scope: "leads", cursor: 40, instance: "inst-1", upperId: 999 }),
      })
    );

    // Call 3 has upperId 999 and cursor 80
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "/api/contacts/sync-avatars",
      expect.objectContaining({
        body: JSON.stringify({ scope: "leads", cursor: 80, instance: "inst-1", upperId: 999 }),
      })
    );

    expect(result.processed).toBe(100);
    expect(result.total).toBe(100);
    expect(result.updated).toBe(30);
    expect(result.noPhoto).toBe(45);
    expect(result.skipped).toBe(25);
    expect(result.failed).toBe(0);
    expect(result.avatars).toEqual({
      "5511999990001@s.whatsapp.net": "https://img.wa/1.jpg",
      "5511999990002@s.whatsapp.net": "https://img.wa/2.jpg",
      "5511999990003@s.whatsapp.net": null,
    });
    expect(progressReports).toEqual([40, 80, 100]);
    expect(receivedAvatars).toHaveLength(3);
  });

  it("retem dados e continua se lote retornar success: false com HTTP 200 (falha parcial)", async () => {
    const batch1: SyncBatchResponse = {
      success: false,
      partial: true,
      instance: "inst-1",
      processed: 40,
      updated: 5,
      noPhoto: 25,
      skipped: 5,
      failed: 5,
      total: 80,
      upperId: 888,
      nextCursor: 40,
      avatars: { "5511999990001@s.whatsapp.net": "https://img.wa/1.jpg" },
    };

    const batch2: SyncBatchResponse = {
      success: true,
      partial: false,
      instance: "inst-1",
      processed: 40,
      updated: 20,
      noPhoto: 15,
      skipped: 5,
      failed: 0,
      total: 80,
      upperId: 888,
      nextCursor: null,
      avatars: { "5511999990002@s.whatsapp.net": "https://img.wa/2.jpg" },
    };

    mockFetch
      .mockResolvedValueOnce(makeResponse(batch1))
      .mockResolvedValueOnce(makeResponse(batch2));

    const result = await syncLeadPhotosSequentially();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(80);
    expect(result.failed).toBe(5);
    expect(result.updated).toBe(25);
    expect(result.avatars["5511999990001@s.whatsapp.net"]).toBe("https://img.wa/1.jpg");
    expect(result.avatars["5511999990002@s.whatsapp.net"]).toBe("https://img.wa/2.jpg");
  });

  it("interrompe imediatamente em resposta non-2xx e propaga erro", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: "Instância desconectada" }, 400, false));

    await expect(syncLeadPhotosSequentially()).rejects.toThrow("Instância desconectada");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("permite cancelar futuras chamadas preservando a resposta do lote em andamento", async () => {
    const isCancelledRef = { current: false };

    const batch1: SyncBatchResponse = {
      success: true,
      partial: false,
      instance: "inst-1",
      processed: 40,
      updated: 10,
      noPhoto: 20,
      skipped: 10,
      failed: 0,
      total: 120,
      upperId: 777,
      nextCursor: 40,
      avatars: { "5511999990001@s.whatsapp.net": "https://img.wa/1.jpg" },
    };

    mockFetch.mockImplementation(async () => {
      // Simula usuário clicando em cancelar enquanto a requisição 1 está em voo
      isCancelledRef.current = true;
      return makeResponse(batch1);
    });

    const result = await syncLeadPhotosSequentially({}, isCancelledRef);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.processed).toBe(40);
    expect(result.updated).toBe(10);
    expect(result.avatars["5511999990001@s.whatsapp.net"]).toBe("https://img.wa/1.jpg");
  });

  it("aborta requisição em voo quando AbortSignal é acionado", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async () => {
      controller.abort();
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    });

    const result = await syncLeadPhotosSequentially({ signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.inFlight).toBe(false);
  });
});
