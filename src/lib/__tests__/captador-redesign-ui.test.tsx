import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
import CaptadorPage from "@/app/captador/page";

const fetchMock = vi.fn<typeof fetch>();
const lead = {
  name: "Clínica de teste", phones: "55999990000", fullAddress: "Rua de teste",
  categories: "Dentista", averageRating: "4,9", reviewCount: "100", website: "",
  instagram: "", facebook: "", extractedAt: "offline",
  businessDetails: { pessoasProcuramPor: ["Ortodontia"], about: "Sobre a clínica", descricao: "Descrição completa" },
  distribuicaoEstrelas: { "5estrelas": 80, "4estrelas": 20 },
};

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(Response.json({ leads: [lead] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class { close() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openLeads(): Promise<void> {
  render(<CaptadorPage />);
  fireEvent.click(screen.getByRole("button", { name: /Leads & Console/ }));
  await screen.findByText("1 clientes");
}

describe("interface redesenhada do Captador", () => {
  it("adiciona sugestões sem duplicar e atualiza o escopo de busca", () => {
    render(<CaptadorPage />);
    fireEvent.click(screen.getByRole("button", { name: "+ Clínicas Odontológicas", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "+ Clínicas Odontológicas", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "+ São Paulo, SP", exact: true }));
    expect(screen.getByLabelText("Nichos (um por linha)")).toHaveValue("Clínicas Odontológicas");
    expect(screen.getByText("1 busca programada")).toBeInTheDocument();
  });

  it("filtra sem alterar os leads e informa busca vazia em desktop e mobile", async () => {
    await openLeads();
    const search = screen.getByRole("textbox", { name: "Buscar leads" });
    fireEvent.change(search, { target: { value: "inexistente" } });
    expect(screen.getAllByText(/Nenhum lead encontrado para o termo/)).toHaveLength(2);
    expect(within(screen.getByRole("table")).queryByText(lead.name)).not.toBeInTheDocument();
    expect(screen.getByText("1 clientes")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Dentista" } });
    expect(within(screen.getByRole("table")).getByText(lead.name)).toBeInTheDocument();
  });

  it("mantém o DDI no WhatsApp de um número nacional com DDD 55", async () => {
    await openLeads();
    expect(screen.getByRole("link", { name: "Abrir no WhatsApp" })).toHaveAttribute("href", "https://wa.me/5555999990000");
    expect(screen.getByText("4.9 ★")).toBeInTheDocument();
  });

  it.each([true, false])("sinaliza o resultado real ao copiar telefone (sucesso=%s)", async success => {
    const writeText = vi.fn().mockImplementation(() => success ? Promise.resolve() : Promise.reject(new Error("Bloqueado")));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await openLeads();
    fireEvent.click(screen.getByRole("button", { name: "Copiar telefone" }));
    expect(await screen.findByRole("button", { name: success ? "Telefone copiado" : "Não foi possível copiar. Tente novamente." })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(lead.phones);
  });

  it("mantém distribuição sem comentários, recomendações e as duas descrições acessíveis", async () => {
    await openLeads();
    fireEvent.click(screen.getByRole("button", { name: "Ver", exact: true }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: /Avaliações/ }));
    expect(dialog.getByText("Distribuição de Notas no Google")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Detalhes Comerciais" }));
    expect(dialog.getByText("Ortodontia")).toBeInTheDocument();
    expect(dialog.getByText("Sobre a clínica")).toBeInTheDocument();
    expect(dialog.getByText("Descrição completa")).toBeInTheDocument();
  });

  it("oferece detalhes comerciais quando há apenas recomendações", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ leads: [{ ...lead, businessDetails: { pessoasProcuramPor: ["Ortodontia"] } }] }));
    await openLeads();
    fireEvent.click(screen.getByRole("button", { name: "Ver", exact: true }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Detalhes Comerciais" }));
    expect(dialog.getByText("Ortodontia")).toBeInTheDocument();
  });
});
