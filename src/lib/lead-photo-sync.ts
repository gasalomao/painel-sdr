/**
 * Pure browser orchestration for sequential lead photo synchronization.
 */

export interface SyncBatchResponse {
  success: boolean;
  partial: boolean;
  instance: string;
  processed: number;
  updated: number;
  noPhoto: number;
  skipped: number;
  failed: number;
  total: number;
  avatars: Record<string, string | null>;
  nextCursor: number | null;
  upperId: number;
  cancelled?: boolean;
}

export interface SyncProgressState {
  processed: number;
  total: number;
  updated: number;
  noPhoto: number;
  skipped: number;
  failed: number;
  instance?: string;
  avatars: Record<string, string | null>;
  inFlight: boolean;
  cancelled: boolean;
  error?: string | null;
}

export interface SyncOptions {
  instance?: string;
  signal?: AbortSignal;
  onProgress?: (state: SyncProgressState) => void;
  onBatchAvatars?: (avatars: Record<string, string | null>) => void;
}

export async function syncLeadPhotosSequentially(
  options: SyncOptions = {},
  isCancelledRef: { current: boolean } = { current: false }
): Promise<SyncProgressState> {
  let cursor: number | null = 0;
  let upperId: number | undefined = undefined;

  const state: SyncProgressState = {
    processed: 0,
    total: 0,
    updated: 0,
    noPhoto: 0,
    skipped: 0,
    failed: 0,
    avatars: {},
    inFlight: true,
    cancelled: false,
    error: null,
  };

  while (cursor !== null && !isCancelledRef.current) {
    if (options.signal?.aborted) {
      state.inFlight = false;
      state.cancelled = true;
      break;
    }

    const payload: { scope: "leads"; instance?: string; cursor?: number; upperId?: number } = {
      scope: "leads",
      cursor,
    };
    if (options.instance) payload.instance = options.instance;
    if (upperId !== undefined) payload.upperId = upperId;

    let res: Response;
    try {
      res = await fetch("/api/contacts/sync-avatars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
    } catch (err: unknown) {
      if (options.signal?.aborted) {
        state.inFlight = false;
        state.cancelled = true;
        break;
      }
      state.inFlight = false;
      state.error = err instanceof Error ? err.message : "Erro ao conectar com servidor";
      throw err;
    }

    // non-2xx stop
    if (!res.ok) {
      let msg = `Falha na sincronização (HTTP ${res.status})`;
      try {
        const json = await res.json();
        if (json?.error) msg = json.error;
      } catch {}
      state.inFlight = false;
      state.error = msg;
      throw new Error(msg);
    }

    const data: SyncBatchResponse = await res.json();

    // Snapshot upperId returned on first request
    if (upperId === undefined && typeof data.upperId === "number") {
      upperId = data.upperId;
    }

    // Accumulate progress
    state.processed += data.processed || 0;
    state.total = data.total || state.total || 0;
    state.updated += data.updated || 0;
    state.noPhoto += data.noPhoto || 0;
    state.skipped += data.skipped || 0;
    state.failed += data.failed || 0;
    if (data.instance) state.instance = data.instance;

    // Retain data and apply avatars even if data.success is false (partial failure with HTTP 200)
    if (data.avatars) {
      Object.assign(state.avatars, data.avatars);
      options.onBatchAvatars?.(data.avatars);
    }

    options.onProgress?.({ ...state });

    if (data.cancelled || isCancelledRef.current) {
      state.cancelled = true;
      break;
    }

    cursor = data.nextCursor;
  }

  state.inFlight = false;
  state.cancelled = isCancelledRef.current || state.cancelled;
  return state;
}
