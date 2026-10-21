// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { fetchProfilePicture } from "@/lib/channel";
import { getEvolutionConfig } from "@/lib/evolution";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("@/lib/channel", () => ({ fetchProfilePicture: vi.fn() }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: vi.fn() }));

const CLIENT_ID = "tenant-a";
const INSTANCE = "tenant-a-instance";
const JID = "5511999999999@s.whatsapp.net";
const MISSING_JID = "5511888888888@s.whatsapp.net";
const PHOTO = "https://pps.whatsapp.net/v/avatar1.jpg";
const NEW_PHOTO = "https://pps.whatsapp.net/v/avatar2.jpg";
const OLD_FETCHED_AT = "2000-01-01T00:00:00.000Z";
const METHODS = ["GET", "POST"] as const;

type Method = (typeof METHODS)[number];
type Table = "contacts" | "channel_connections";
type DatabaseError = { message: string };
type Contact = Record<string, unknown> & {
  client_id: string;
  remote_jid: string;
  profile_pic_url: string | null;
  profile_pic_fetched_at: string | null;
};
type Connection = Record<string, unknown> & {
  client_id: string;
  instance_name: string;
};

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    client_id: CLIENT_ID,
    remote_jid: JID,
    profile_pic_url: PHOTO,
    profile_pic_fetched_at: new Date().toISOString(),
    ...overrides,
  };
}

function database(options: {
  contacts?: Contact[];
  connections?: Connection[];
  readErrors?: Partial<Record<Table, DatabaseError>>;
  upsertError?: DatabaseError;
} = {}) {
  const contacts = (options.contacts ?? []).map(row => ({ ...row }));
  const connections = options.connections ?? [{ client_id: CLIENT_ID, instance_name: INSTANCE }];
  const upsert = vi.fn(async (row: Contact) => {
    if (options.upsertError) return { data: null, error: options.upsertError };
    const existing = contacts.find(item => item.client_id === row.client_id && item.remote_jid === row.remote_jid);
    if (existing) Object.assign(existing, row);
    else contacts.push({ ...row });
    return { data: null, error: null };
  });

  vi.mocked(supabaseAdmin.from).mockImplementation((tableName) => {
    if (tableName !== "contacts" && tableName !== "channel_connections") {
      throw new Error(`Unexpected Supabase table: ${tableName}`);
    }
    const table: Table = tableName;
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let rowLimit = Infinity;
    const read = (single: boolean) => {
      const error = options.readErrors?.[table] ?? null;
      const rows = (table === "contacts" ? contacts : connections)
        .filter(row => filters.every(filter => filter(row)))
        .slice(0, rowLimit);
      return { data: error ? null : single ? rows[0] ?? null : rows, error };
    };
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push(row => row[column] === value);
        return query;
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        filters.push(row => values.includes(row[column]));
        return query;
      }),
      limit: vi.fn((value: number) => {
        rowLimit = value;
        return query;
      }),
      maybeSingle: vi.fn(async () => read(true)),
      then: (resolve: (value: ReturnType<typeof read>) => unknown) => Promise.resolve(read(false)).then(resolve),
      upsert,
    };
    return query as unknown as ReturnType<typeof supabaseAdmin.from>;
  });

  return { contacts, upsert };
}

function request(method: Method, payload: Record<string, unknown>): NextRequest {
  const url = new URL("http://localhost/api/contacts/avatars");
  if (method === "GET") {
    for (const [key, value] of Object.entries(payload)) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
    return new NextRequest(url);
  }
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function invoke(method: Method, payload: Record<string, unknown>) {
  return (method === "GET" ? GET : POST)(request(method, payload));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireClientId).mockResolvedValue({
    ok: true,
    clientId: CLIENT_ID,
    isAdmin: true,
    impersonating: false,
    claims: {
      clientId: CLIENT_ID,
      actorId: CLIENT_ID,
      email: "admin@example.test",
      name: "Admin",
      isAdmin: true,
      impersonating: false,
      features: {},
      sessionId: "test-session",
    },
  });
  vi.mocked(fetchProfilePicture).mockResolvedValue(NEW_PHOTO);
  vi.mocked(getEvolutionConfig).mockResolvedValue({
    instance: "global-instance",
    url: "https://evolution.example.test",
    apiKey: "test-only",
    source: "env",
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network I/O")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.each(METHODS)("%s /api/contacts/avatars", (method) => {
  it("returns scoped cached avatars without a connected instance when cachedOnly is enabled", async () => {
    const db = database({
      connections: [],
      contacts: [contact(), contact({ client_id: "tenant-b", remote_jid: MISSING_JID, profile_pic_url: NEW_PHOTO })],
    });

    const response = await invoke(method, { jids: [JID, MISSING_JID], cachedOnly: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      avatars: { [JID]: PHOTO, [MISSING_JID]: null },
      refreshed: 0,
      instance: null,
    });
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith("channel_connections");
    expect(fetchProfilePicture).not.toHaveBeenCalled();
    expect(getEvolutionConfig).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("rejects another tenant's explicit instance even for an administrator", async () => {
    const db = database({
      connections: [{ client_id: "tenant-b", instance_name: "tenant-b-instance" }],
      contacts: [contact({ client_id: "tenant-b" })],
    });

    const response = await invoke(method, { jids: [JID], instance: "tenant-b-instance", force: true });

    expect([403, 404]).toContain(response.status);
    expect((await response.json()).success).toBe(false);
    expect(supabaseAdmin.from).not.toHaveBeenCalledWith("contacts");
    expect(fetchProfilePicture).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it.each([true, false])("blocks invalid cached URLs/base64 with cachedOnly=%s", async (cachedOnly) => {
    const invalidPhotos = [
      "javascript:alert(1)",
      "not-a-url",
      "data:image/png;base64,%%%",
      "data:text/html;base64,PHNjcmlwdD4=",
    ];
    const invalidJids = invalidPhotos.map((_, index) => `551177777770${index}@s.whatsapp.net`);
    const db = database({
      contacts: [contact(), ...invalidPhotos.map((url, index) => contact({ remote_jid: invalidJids[index], profile_pic_url: url }))],
    });

    const response = await invoke(method, { jids: [JID, ...invalidJids], instance: INSTANCE, cachedOnly });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.avatars[JID]).toBe(PHOTO);
    for (const jid of invalidJids) {
      if (cachedOnly) expect.soft(body.avatars[jid]).toBeNull();
      else expect.soft([null, NEW_PHOTO]).toContain(body.avatars[jid]);
    }
    if (cachedOnly) {
      expect(fetchProfilePicture).not.toHaveBeenCalled();
      expect(db.upsert).not.toHaveBeenCalled();
    }
  });

  it.each([true, false])("returns a server error for failed cache reads with cachedOnly=%s", async (cachedOnly) => {
    const db = database({ readErrors: { contacts: { message: "cache read unavailable" } } });

    const response = await invoke(method, { jids: [JID], instance: INSTANCE, cachedOnly });
    const body = await response.json();

    expect.soft(response.status).toBe(500);
    expect.soft(body.success).toBe(false);
    expect(fetchProfilePicture).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it.each([true, false])("returns a server error for failed connection reads with explicitInstance=%s", async (explicitInstance) => {
    const db = database({ readErrors: { channel_connections: { message: "connection read unavailable" } } });

    const response = await invoke(method, { jids: [JID], ...(explicitInstance ? { instance: INSTANCE } : {}) });

    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
    expect(fetchProfilePicture).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it.each(["rejection", "null"] as const)("preserves the valid cached photo and timestamp after provider %s", async (failure) => {
    const cached = contact({ profile_pic_fetched_at: OLD_FETCHED_AT });
    const db = database({ contacts: [cached] });
    if (failure === "rejection") vi.mocked(fetchProfilePicture).mockRejectedValueOnce(new Error("provider unavailable"));
    else vi.mocked(fetchProfilePicture).mockResolvedValue(null);

    const response = await invoke(method, { jids: [JID], instance: INSTANCE, force: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchProfilePicture).toHaveBeenCalledWith(JID, INSTANCE, CLIENT_ID);
    expect.soft(body.avatars[JID]).toBe(PHOTO);
    expect.soft(body.refreshed).toBe(0);
    expect.soft(db.contacts).toEqual([cached]);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("does not count a failed upsert as refreshed or replace the cached response", async () => {
    const cached = contact({ profile_pic_fetched_at: OLD_FETCHED_AT });
    const db = database({ contacts: [cached], upsertError: { message: "avatar write failed" } });

    const response = await invoke(method, { jids: [JID], instance: INSTANCE, force: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchProfilePicture).toHaveBeenCalledWith(JID, INSTANCE, CLIENT_ID);
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect.soft(body.refreshed).toBe(0);
    expect.soft(body.avatars[JID]).toBe(PHOTO);
    expect(db.contacts).toEqual([cached]);
  });

  it("counts a successful persisted refresh and keeps it inside the authenticated tenant", async () => {
    const db = database({ contacts: [contact({ profile_pic_fetched_at: OLD_FETCHED_AT })] });

    const response = await invoke(method, { jids: [JID], instance: INSTANCE, force: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, avatars: { [JID]: NEW_PHOTO }, refreshed: 1 });
    expect(db.contacts).toEqual([expect.objectContaining({ client_id: CLIENT_ID, remote_jid: JID, profile_pic_url: NEW_PHOTO })]);
    expect(db.contacts[0].profile_pic_fetched_at).not.toBe(OLD_FETCHED_AT);
  });
});
