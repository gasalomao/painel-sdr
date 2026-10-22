import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SitesPage from "./page";
import { CreateSiteDialog } from "@/components/sites/create-site-dialog";

const fetchMock = vi.fn<typeof fetch>();
const project = { id: "project-test", name: "Padaria Central", status: "draft", client_context: { name: "Padaria" }, model_mode: "auto", model_id: null, updated_at: "2026-10-21T12:00:00Z", published_url: null, last_published_at: null };

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", class { observe(): void {} disconnect(): void {} });
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/sites/models") return Response.json({ models: [] });
    if (init?.method === "POST") return Response.json({ project });
    return Response.json({ projects: [project] });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Sites IA — ações e contratos preservados", () => {
  it("exibe edição explícita e não exclui ao cancelar a confirmação", async () => {
    render(<SitesPage />);
    expect(await screen.findByRole("link", { name: `Editar ${project.name}` })).toHaveAttribute("href", "/sites/project-test");
    fireEvent.click(screen.getByRole("button", { name: `Excluir site "${project.name}"` }));
    expect(screen.getByRole("dialog", { name: "Excluir site" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(screen.getByRole("heading", { name: project.name })).toBeInTheDocument();
  });

  it("mantém exclusão explícita no endpoint original", async () => {
    render(<SitesPage />);
    await screen.findByRole("heading", { name: project.name });
    fireEvent.click(screen.getByRole("button", { name: `Excluir site "${project.name}"` }));
    fireEvent.click(screen.getByRole("button", { name: "Excluir definitivamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Seu primeiro site começa aqui" })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/sites/project-test", expect.objectContaining({ method: "DELETE" }));
  });

  it("cria com modo automático e mantém geração separada da publicação", async () => {
    render(<CreateSiteDialog open onOpenChange={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Criar e gerar site" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome do projeto"), { target: { value: "Padaria Central" } });
    fireEvent.change(screen.getByLabelText("Descreva o site (obrigatório)"), { target: { value: "Uma página com serviços e contato." } });
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/sites/project-test"));
    const create = fetchMock.mock.calls.find(([url, init]) => url === "/api/sites" && init?.method === "POST");
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ name: "Padaria Central", client_context: {}, model_mode: "auto" });
    const generate = fetchMock.mock.calls.find(([url]) => url === "/api/sites/project-test/runs");
    expect(JSON.parse(String(generate?.[1]?.body))).toEqual({ prompt: "Uma página com serviços e contato.", asset_ids: [] });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("deployments"))).toBe(false);
  });
});
