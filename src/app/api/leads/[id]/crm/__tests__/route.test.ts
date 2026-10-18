import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PATCH } from "@/app/api/leads/[id]/crm/route";
import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn() }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("@/lib/channel", () => ({ fetchProfilePicture: vi.fn() }));

const due = "2026-10-30T10:00:00.000Z";
const context = { params: Promise.resolve({ id: "101" }) };
type StoredLead = {
  id: string;
  client_id: string;
  observacoes: string | null;
  next_follow_up: string | null;
  business_details: Record<string, unknown> | null;
};
const emptyLead: StoredLead = {
  id: "101", client_id: "tenant-123", observacoes: "Anotação original", next_follow_up: null,
  business_details: { servicos: ["Site"] },
};

function database(current: StoredLead | null = emptyLead, options: { zeroRows?: boolean; readError?: string; updateError?: string } = {}) {
  const read = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: current, error: options.readError ? { message: options.readError } : null }),
  };
  const write = {
    eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockImplementation(async () => ({
      data: options.zeroRows ? null : { ...current, ...update.mock.calls[0][0] },
      error: options.updateError ? { message: options.updateError } : null,
    })),
  };
  const update = vi.fn().mockReturnValue(write);
  vi.mocked(supabaseAdmin.from).mockReturnValue({ ...read, update } as unknown as ReturnType<typeof supabaseAdmin.from>);
  return { read, write, update };
}

async function patch(payload: unknown): Promise<NextResponse> {
  return PATCH(new NextRequest("http://localhost/api/leads/101/crm", {
    method: "PATCH", body: JSON.stringify(payload),
  }), context);
}

describe("API /api/leads/[id]/crm", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireClientId).mockResolvedValue({
      ok: true, clientId: "tenant-123", isAdmin: false, impersonating: false, claims: {} as never,
    });
  });

  it("PATCH atualiza só anotações para o tenant autorizado, sem exigir lembrete", async () => {
    const db = database();
    const res = await patch({ observacoes: "  Contato solicitou proposta  " });
    expect(res.status).toBe(200);
    expect((await res.json()).lead.observacoes).toBe("Contato solicitou proposta");
    expect(db.read.select).not.toHaveBeenCalled();
    expect(db.write.eq.mock.calls).toEqual([["id", "101"], ["client_id", "tenant-123"]]);
    expect(db.update).toHaveBeenCalledWith({ observacoes: "Contato solicitou proposta", updated_at: expect.any(String) });
  });

  it("PATCH grava par completo e preserva anotações e dados comerciais", async () => {
    const db = database();
    const res = await patch({ next_follow_up: due, lembrete_texto: "  entregar projeto x  " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead.lembrete_texto).toBe("entregar projeto x");
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({
      next_follow_up: due, business_details: { servicos: ["Site"], lembrete_texto: "entregar projeto x" },
    }));
    expect(db.update.mock.calls[0][0]).not.toHaveProperty("observacoes");
    expect(db.read.eq.mock.calls).toEqual([["id", "101"], ["client_id", "tenant-123"]]);
    expect(db.write.eq.mock.calls).toEqual([["id", "101"], ["client_id", "tenant-123"]]);
  });

  it.each([
    null, [], {}, { observacoes: 42 }, { lembrete_texto: "x".repeat(1001) },
    { lembrete_texto: "  ", next_follow_up: due }, { next_follow_up: false },
    { next_follow_up: "2026-10-30T10:00" }, { next_follow_up: "data-invalida" },
  ])("PATCH rejeita entrada inválida sem escrever: %j", async (payload) => {
    const db = database();
    expect((await patch(payload)).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    "2026-02-30T10:00:00Z", "2026-02-29T10:00:00-03:00", "2026-04-31T10:00:00+02:00",
    "2026-13-01T10:00:00Z", "2026-01-00T10:00:00Z", "2026-10-30T25:00:00Z",
    "2026-10-30T10:00:00+25:00",
  ])("PATCH rejeita data de calendário impossível: %s", async (next_follow_up) => {
    const db = database();
    const res = await patch({ next_follow_up, lembrete_texto: "Ligar" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Formato de data inválido");
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ["2028-02-29T23:30:00-03:00", "2028-03-01T02:30:00.000Z"],
    ["2026-10-30T00:15:00+02:00", "2026-10-29T22:15:00.000Z"],
  ])("PATCH aceita data válida com timezone: %s", async (next_follow_up, expected) => {
    const db = database();
    expect((await patch({ next_follow_up, lembrete_texto: "Ligar" })).status).toBe(200);
    expect(db.update.mock.calls[0][0].next_follow_up).toBe(expected);
  });

  it.each([
    { next_follow_up: due }, { lembrete_texto: "Ligar" }, { observacoes: "Ligar", next_follow_up: due },
  ])("PATCH não ativa par incompleto mesmo com anotações existentes: %j", async (payload) => {
    const db = database();
    expect((await patch(payload)).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH não aceita vencimento isolado se lembrete existente também não tem texto", async () => {
    const db = database({ ...emptyLead, observacoes: null, next_follow_up: due });
    expect((await patch({ next_follow_up: "2026-11-01T10:00:00Z" })).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH valida par efetivo após alterar também a anotação legada", async () => {
    const db = database({ ...emptyLead, next_follow_up: due });
    expect((await patch({ next_follow_up: "2026-11-01T10:00:00Z", observacoes: null })).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([null, "", "  "])("PATCH não apaga texto de lembrete ativo sem concluir: %j", async (lembrete_texto) => {
    const db = database({ ...emptyLead, next_follow_up: due, business_details: { lembrete_texto: "Ligar" } });
    expect((await patch({ lembrete_texto })).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH aceita editar apenas texto quando já existe vencimento", async () => {
    const db = database({ ...emptyLead, next_follow_up: due });
    const res = await patch({ lembrete_texto: "Enviar proposta" });
    expect(res.status).toBe(200);
    expect((await res.json()).lead).toMatchObject({ next_follow_up: due, lembrete_texto: "Enviar proposta" });
    expect(db.update.mock.calls[0][0]).not.toHaveProperty("next_follow_up");
  });

  it("PATCH aceita editar apenas data usando texto armazenado, sem sobrescrevê-lo", async () => {
    const db = database({ ...emptyLead, next_follow_up: due, business_details: { lembrete_texto: "Ligar" } });
    const res = await patch({ next_follow_up: "2026-11-01T10:00:00Z" });
    expect(res.status).toBe(200);
    expect((await res.json()).lead.lembrete_texto).toBe("Ligar");
    expect(db.update.mock.calls[0][0]).not.toHaveProperty("business_details");
    expect(db.read.eq).toHaveBeenCalledWith("client_id", "tenant-123");
  });

  it("PATCH pode reativar lembrete com texto armazenado sem recorrer às anotações", async () => {
    database({ ...emptyLead, business_details: { lembrete_texto: "Ligar" } });
    expect((await patch({ next_follow_up: due })).status).toBe(200);
  });

  it("PATCH preserva leitura de texto legado apenas se já existe vencimento", async () => {
    const db = database({ ...emptyLead, next_follow_up: due });
    const res = await patch({ next_follow_up: "2026-11-01T10:00:00Z" });
    expect(res.status).toBe(200);
    expect((await res.json()).lead.lembrete_texto).toBe("Anotação original");
    expect(db.update.mock.calls[0][0]).not.toHaveProperty("business_details");
  });

  it.each([{ next_follow_up: null }, { next_follow_up: null, lembrete_texto: null }])("PATCH preserva conclusão sem exigir par: %j", async (payload) => {
    const db = database({ ...emptyLead, next_follow_up: due });
    const res = await patch(payload);
    expect(res.status).toBe(200);
    expect((await res.json()).lead).toMatchObject({ next_follow_up: null, lembrete_texto: null });
    expect(db.update.mock.calls[0][0]).not.toHaveProperty("observacoes");
  });

  it("PATCH não escreve lead ausente ou de outro tenant na validação do par", async () => {
    const db = database(null);
    expect((await patch({ next_follow_up: due, lembrete_texto: "Ligar" })).status).toBe(404);
    expect(db.read.eq.mock.calls).toEqual([["id", "101"], ["client_id", "tenant-123"]]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([{ observacoes: "Nota" }, { next_follow_up: due, lembrete_texto: "Ligar" }])("PATCH retorna 404 se update afetar zero rows: %j", async (payload) => {
    const db = database(emptyLead, { zeroRows: true });
    expect((await patch(payload)).status).toBe(404);
    expect(db.write.eq.mock.calls).toEqual([["id", "101"], ["client_id", "tenant-123"]]);
  });

  it("PATCH propaga erro da leitura sem tentar salvar", async () => {
    const db = database(emptyLead, { readError: "Falha de leitura" });
    const res = await patch({ next_follow_up: due, lembrete_texto: "Ligar" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Falha de leitura");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("PATCH propaga erro de update", async () => {
    database(emptyLead, { updateError: "Falha de escrita" });
    expect((await patch({ observacoes: "Nota" })).status).toBe(500);
  });

  it("PATCH exige autenticação antes de ler ou escrever", async () => {
    vi.mocked(requireClientId).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Não autorizado" }, { status: 401 }) });
    expect((await patch({ next_follow_up: due, lembrete_texto: "Ligar" })).status).toBe(401);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it("GET retorna lead e profilePicUrl do cache", async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      const query = {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ remote_jid: "5511999999999@s.whatsapp.net", profile_pic_url: "https://pps.whatsapp.net/v/photo.jpg" }], error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: table === "leads_extraidos" ? {
          id: "101", nome_negocio: "Loja Exemplo", remoteJid: "5511999999999@s.whatsapp.net", client_id: "tenant-123",
        } : null, error: null }),
      };
      return query as unknown as ReturnType<typeof supabaseAdmin.from>;
    });
    const res = await GET(new NextRequest("http://localhost/api/leads/101/crm"), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lead: { nome_negocio: "Loja Exemplo" }, profilePicUrl: "https://pps.whatsapp.net/v/photo.jpg" });
  });

  it.each([null, due])("GET usa anotações legadas como texto só com vencimento existente: %s", async (next_follow_up) => {
    database({ ...emptyLead, next_follow_up });
    const res = await GET(new NextRequest("http://localhost/api/leads/101/crm"), context);
    expect(res.status).toBe(200);
    expect((await res.json()).lembrete_texto).toBe(next_follow_up ? "Anotação original" : "");
  });
});
