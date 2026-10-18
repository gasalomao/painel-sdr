import React, { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { toast } from "sonner";
import { LeadDrawer, LeadDrawerData } from "../lead-drawer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockFetch = vi.fn();
const mockGet = vi.fn();
const mockPatch = vi.fn();
const mockPost = vi.fn();
const sampleLead: LeadDrawerData = {
  id: 123,
  nome_negocio: "Auto Mecânica Silva",
  telefone: "5511999998888",
  ramo_negocio: "Oficina Mecânica",
  endereco: "Rua das Flores, 100",
  website: "https://mecanicasilva.com.br",
  status: "novo",
  remoteJid: "5511999998888@s.whatsapp.net",
  observacoes: "Lead interessado em revisão de frota",
  next_follow_up: "2026-10-25T14:00:00.000Z",
  profilePicUrl: "https://pps.whatsapp.net/v/avatar123.jpg",
};

function response(body: unknown = {}, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function reminderText(): HTMLElement {
  return screen.getByLabelText(/O que você precisa lembrar/i);
}

function reminderDue(): HTMLElement {
  return screen.getByLabelText(/Data e Horário de Vencimento/i);
}

function selectTab(name: RegExp): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("LeadDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReset().mockResolvedValue(response());
    mockPatch.mockReset().mockResolvedValue(response({ success: true }));
    mockPost.mockReset().mockResolvedValue(response({ success: true, avatars: {} }));
    mockFetch.mockReset().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return mockPatch(url, init);
      if (init?.method === "POST") return mockPost(url, init);
      return mockGet(url, init);
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renderiza cabeçalho com nome, categoria e iniciais de fallback", () => {
    render(<LeadDrawer lead={sampleLead} open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Auto Mecânica Silva")).toBeInTheDocument();
    expect(screen.getByText("Oficina Mecânica")).toBeInTheDocument();
    expect(screen.getByText("AM")).toBeInTheDocument();
  });

  it("salva anotações com resposta PATCH separada do GET inicial", async () => {
    const onLeadUpdated = vi.fn();
    render(<LeadDrawer lead={sampleLead} open defaultTab="notes" onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
    fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Nova anotação" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar Anotações/i }));

    await waitFor(() => expect(onLeadUpdated).toHaveBeenCalledWith({ id: 123, observacoes: "Nova anotação" }));
    expect(mockPatch).toHaveBeenCalledWith("/api/leads/123/crm", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ observacoes: "Nova anotação" }),
    }));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("conclui lembrete limpando vencimento e descrição", async () => {
    const onLeadUpdated = vi.fn();
    render(<LeadDrawer lead={sampleLead} open defaultTab="reminders" onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: /Concluir Lembrete/i }));

    await waitFor(() => expect(onLeadUpdated).toHaveBeenCalledWith({ id: 123, next_follow_up: null, lembrete_texto: null }));
    expect(mockPatch).toHaveBeenCalledWith("/api/leads/123/crm", expect.objectContaining({ body: JSON.stringify({ next_follow_up: null }) }));
    expect(reminderText()).toHaveValue("");
    expect(reminderDue()).toHaveValue("");
  });

  it("agenda lembrete com descrição e vencimento", async () => {
    const onLeadUpdated = vi.fn();
    render(<LeadDrawer lead={sampleLead} open defaultTab="reminders" onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
    fireEvent.change(reminderText(), { target: { value: "entregar projeto x" } });
    fireEvent.change(reminderDue(), { target: { value: "2026-10-30T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar Lembrete/i }));

    await waitFor(() => expect(onLeadUpdated).toHaveBeenCalledWith({
      id: 123, lembrete_texto: "entregar projeto x", next_follow_up: new Date("2026-10-30T10:00").toISOString(),
    }));
    expect(mockPatch).toHaveBeenCalledWith("/api/leads/123/crm", expect.objectContaining({
      body: JSON.stringify({ next_follow_up: new Date("2026-10-30T10:00").toISOString(), lembrete_texto: "entregar projeto x" }),
    }));
  });

  it("exibe erro da mutation sem consumir a resposta no GET", async () => {
    mockPatch.mockResolvedValue(response({ error: "Não foi possível salvar" }, false));
    const onLeadUpdated = vi.fn();
    render(<LeadDrawer lead={sampleLead} open defaultTab="notes" onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: /Salvar Anotações/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível salvar"));
    expect(onLeadUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Salvar Anotações/i })).toBeEnabled();
  });

  it.each(["troca de lead", "fechar e reabrir"] as const)("preserva o novo formulário e bloqueio após PATCH antigo: %s", async (transition) => {
    const oldPatch = deferred<Response>();
    const newPatch = deferred<Response>();
    mockPatch.mockReturnValueOnce(oldPatch.promise).mockReturnValueOnce(newPatch.promise);
    const onLeadUpdated = vi.fn();
    const props = { open: true, defaultTab: "reminders" as const, onOpenChange: vi.fn(), onLeadUpdated };
    const { rerender } = render(<LeadDrawer {...props} lead={sampleLead} />);
    fireEvent.click(screen.getByRole("button", { name: /Concluir Lembrete/i }));

    const nextLead = transition === "troca de lead" ? { ...sampleLead, id: 456, nome_negocio: "Lead B" } : sampleLead;
    if (transition === "fechar e reabrir") rerender(<LeadDrawer {...props} lead={sampleLead} open={false} />);
    rerender(<LeadDrawer {...props} lead={nextLead} />);
    fireEvent.change(reminderText(), { target: { value: "Rascunho novo" } });
    fireEvent.change(reminderDue(), { target: { value: "2026-11-10T09:30" } });
    const save = screen.getByRole("button", { name: /Salvar Lembrete/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(save).toBeDisabled();

    await act(async () => { oldPatch.resolve(response({ success: true })); });
    expect(reminderText()).toHaveValue("Rascunho novo");
    expect(reminderDue()).toHaveValue("2026-11-10T09:30");
    expect(save).toBeDisabled();
    expect(onLeadUpdated).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => { newPatch.resolve(response({ success: true })); });
    expect(save).toBeEnabled();
    expect(onLeadUpdated).toHaveBeenCalledTimes(1);
    expect(onLeadUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: nextLead.id, lembrete_texto: "Rascunho novo" }));
  });

  it.each(["notes", "reminders"] as const)("ignora erro PATCH de outra abertura na aba %s", async (tab) => {
    const pending = deferred<Response>();
    mockPatch.mockReturnValueOnce(pending.promise);
    const props = { lead: sampleLead, open: true, defaultTab: tab, onOpenChange: vi.fn(), onLeadUpdated: vi.fn() };
    const { rerender } = render(<LeadDrawer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: tab === "notes" ? /Salvar Anotações/i : /Salvar Lembrete/i }));
    rerender(<LeadDrawer {...props} open={false} />);
    rerender(<LeadDrawer {...props} />);
    await act(async () => { pending.resolve(response({ error: "Erro antigo" }, false)); });
    expect(toast.error).not.toHaveBeenCalled();
    expect(props.onLeadUpdated).not.toHaveBeenCalled();
  });

  it.each(["troca de lead", "fechar e reabrir"] as const)("PATCH de notas antigo não confirma nem destrava o novo save: %s", async (transition) => {
    const oldPatch = deferred<Response>();
    const newPatch = deferred<Response>();
    mockPatch.mockReturnValueOnce(oldPatch.promise).mockReturnValueOnce(newPatch.promise);
    const onLeadUpdated = vi.fn();
    const props = { open: true, defaultTab: "notes" as const, onOpenChange: vi.fn(), onLeadUpdated };
    const { rerender } = render(<LeadDrawer {...props} lead={sampleLead} />);
    fireEvent.click(screen.getByRole("button", { name: /Salvar Anotações/i }));
    if (transition === "fechar e reabrir") rerender(<LeadDrawer {...props} lead={sampleLead} open={false} />);
    const nextLead = transition === "troca de lead" ? { ...sampleLead, id: 456 } : sampleLead;
    rerender(<LeadDrawer {...props} lead={nextLead} />);
    fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Nova nota" } });
    const save = screen.getByRole("button", { name: /Salvar Anotações/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await act(async () => { oldPatch.resolve(response({ success: true })); });
    expect(save).toBeDisabled();
    expect(onLeadUpdated).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Falou com o gerente/i)).toHaveValue("Nova nota");
    await act(async () => { newPatch.resolve(response({ success: true })); });
    expect(save).toBeEnabled();
    expect(onLeadUpdated).toHaveBeenCalledTimes(1);
    expect(onLeadUpdated).toHaveBeenCalledWith({ id: nextLead.id, observacoes: "Nova nota" });
  });

  it("salvar notas atualiza o objeto lead sem perder rascunho de lembrete", async () => {
    function Parent() {
      const [lead, setLead] = useState(sampleLead);
      return <LeadDrawer lead={lead} open defaultTab="reminders" onOpenChange={vi.fn()} onLeadUpdated={(updated) => setLead((prev) => ({ ...prev, ...updated }))} />;
    }
    render(<Parent />);
    fireEvent.change(reminderText(), { target: { value: "Rascunho ainda não salvo" } });
    fireEvent.change(reminderDue(), { target: { value: "2026-11-01T10:20" } });
    selectTab(/Anotações/i);
    fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Nota salva" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar Anotações/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Anotações salvas com sucesso!"));
    selectTab(/Lembretes & Retorno/i);
    expect(reminderText()).toHaveValue("Rascunho ainda não salvo");
    expect(reminderDue()).toHaveValue("2026-11-01T10:20");
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it.each(["observacoes", "lembrete_texto", "next_follow_up"] as const)("GET atrasado preserva só o campo editado %s e atualiza os demais", async (field) => {
    const pending = deferred<Response>();
    mockGet.mockReturnValueOnce(pending.promise);
    render(<LeadDrawer lead={sampleLead} open defaultTab="reminders" onOpenChange={vi.fn()} />);
    if (field === "observacoes") {
      selectTab(/Anotações/i);
      fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Nota em edição" } });
    } else {
      fireEvent.change(field === "lembrete_texto" ? reminderText() : reminderDue(), {
        target: { value: field === "lembrete_texto" ? "Texto em edição" : "2026-11-02T08:15" },
      });
    }
    const freshDue = new Date("2026-12-03T09:45").toISOString();
    await act(async () => { pending.resolve(response({
      lead: { observacoes: "Nota fresca", next_follow_up: freshDue }, lembrete_texto: "Texto fresco",
    })); });
    selectTab(/Anotações/i);
    expect(screen.getByPlaceholderText(/Falou com o gerente/i)).toHaveValue(field === "observacoes" ? "Nota em edição" : "Nota fresca");
    selectTab(/Lembretes & Retorno/i);
    expect(reminderText()).toHaveValue(field === "lembrete_texto" ? "Texto em edição" : "Texto fresco");
    expect(reminderDue()).toHaveValue(field === "next_follow_up" ? "2026-11-02T08:15" : "2026-12-03T09:45");
  });

  it.each(["troca de lead", "fechar e reabrir"] as const)("descarta GET de geração anterior: %s", async (transition) => {
    const pending = deferred<Response>();
    mockGet.mockReturnValueOnce(pending.promise);
    const props = { open: true, defaultTab: "reminders" as const, onOpenChange: vi.fn() };
    const { rerender } = render(<LeadDrawer {...props} lead={sampleLead} />);
    if (transition === "fechar e reabrir") rerender(<LeadDrawer {...props} lead={sampleLead} open={false} />);
    const nextLead = transition === "troca de lead" ? { ...sampleLead, id: 456 } : sampleLead;
    rerender(<LeadDrawer {...props} lead={nextLead} />);
    await act(async () => { pending.resolve(response({ lead: { observacoes: "Antigo", next_follow_up: null }, lembrete_texto: "Antigo" })); });
    expect(reminderText()).toHaveValue(sampleLead.observacoes);
    expect(reminderDue()).not.toHaveValue("");
  });

  describe("Sincronização individual de foto do WhatsApp", () => {
    it("chama POST /api/contacts/avatars com force:true e atualiza foto e notifica parent", async () => {
      const onLeadUpdated = vi.fn();
      mockPost.mockResolvedValue(response({
        success: true,
        updated: 1,
        noPhoto: 0,
        failed: 0,
        avatars: { "5511999998888@s.whatsapp.net": "https://pps.whatsapp.net/v/nova-foto.jpg" },
      }));

      render(<LeadDrawer lead={sampleLead} open onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
      const btn = screen.getByRole("button", { name: /Atualizar foto do WhatsApp/i });
      fireEvent.click(btn);

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          "/api/contacts/avatars",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              jids: ["5511999998888@s.whatsapp.net"],
              force: true,
            }),
          })
        );
      });

      await waitFor(() => {
        expect(onLeadUpdated).toHaveBeenCalledWith({
          id: 123,
          profilePicUrl: "https://pps.whatsapp.net/v/nova-foto.jpg",
        });
        expect(toast.success).toHaveBeenCalledWith("Foto do WhatsApp atualizada!");
      });
    });

    it("avisa quando contato não possui foto pública e limpa foto informando parent", async () => {
      const onLeadUpdated = vi.fn();
      mockPost.mockResolvedValue(response({
        success: true,
        updated: 0,
        noPhoto: 1,
        failed: 0,
        avatars: { "5511999998888@s.whatsapp.net": null },
      }));

      render(<LeadDrawer lead={sampleLead} open onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
      const btn = screen.getByRole("button", { name: /Atualizar foto do WhatsApp/i });
      fireEvent.click(btn);

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith("Contato não possui foto pública no WhatsApp.");
        expect(onLeadUpdated).toHaveBeenCalledWith({
          id: 123,
          profilePicUrl: null,
        });
      });
    });

    it("exibe erro honestamente quando endpoint falha e não apaga foto nem rascunhos", async () => {
      const onLeadUpdated = vi.fn();
      mockPost.mockResolvedValue(response({ error: "Instância desconectada", failed: 1 }, 400, false));

      render(<LeadDrawer lead={sampleLead} open defaultTab="notes" onOpenChange={vi.fn()} onLeadUpdated={onLeadUpdated} />);
      fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Rascunho de nota" } });

      const btn = screen.getByRole("button", { name: /Atualizar foto do WhatsApp/i });
      fireEvent.click(btn);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Instância desconectada");
      });
      expect(onLeadUpdated).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText(/Falou com o gerente/i)).toHaveValue("Rascunho de nota");
    });

    it("sincroniza nova foto do mesmo lead vinda do parent sem resetar rascunhos em edição", () => {
      const props = { open: true, defaultTab: "notes" as const, onOpenChange: vi.fn(), onLeadUpdated: vi.fn() };
      const { rerender } = render(<LeadDrawer {...props} lead={sampleLead} />);

      fireEvent.change(screen.getByPlaceholderText(/Falou com o gerente/i), { target: { value: "Nota não salva ainda" } });

      // Parent atualiza foto (ex: sync em lote concluiu para este lead)
      rerender(<LeadDrawer {...props} lead={{ ...sampleLead, profilePicUrl: "https://pps.whatsapp.net/v/foto-sincronizada.jpg" }} />);

      // Rascunho permanece intocado
      expect(screen.getByPlaceholderText(/Falou com o gerente/i)).toHaveValue("Nota não salva ainda");
    });

    it("descarta resposta de busca de foto se lead foi trocado antes da resposta (generation guard)", async () => {
      const pending = deferred<Response>();
      mockPost.mockReturnValueOnce(pending.promise);
      const onLeadUpdated = vi.fn();

      const props = { open: true, onOpenChange: vi.fn(), onLeadUpdated };
      const { rerender } = render(<LeadDrawer {...props} lead={sampleLead} />);

      const btn = screen.getByRole("button", { name: /Atualizar foto do WhatsApp/i });
      fireEvent.click(btn);

      // Troca de lead para ID 456
      rerender(<LeadDrawer {...props} lead={{ ...sampleLead, id: 456, remoteJid: "5511977776666@s.whatsapp.net" }} />);

      // Resposta da foto anterior chega
      await act(async () => {
        pending.resolve(response({
          success: true,
          updated: 1,
          avatars: { "5511999998888@s.whatsapp.net": "https://pps.whatsapp.net/v/foto-antiga.jpg" },
        }));
      });

      expect(onLeadUpdated).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
