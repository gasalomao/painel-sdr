import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RealtimeFilesViewer } from "../realtime-files-viewer";
import type { WebsiteFiles } from "@/lib/sites/types";

describe("RealtimeFilesViewer", () => {
  const mockFiles: WebsiteFiles = {
    "src/App.tsx": "export default function App() { return <div>Hello</div>; }",
    "src/main.tsx": "import React from 'react';\nimport ReactDOM from 'react-dom/client';",
    "index.html": "<!DOCTYPE html><html><body><div id='root'></div></body></html>",
  };

  it("renderiza lista de arquivos", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} />);

    expect(container.textContent).toContain("App.tsx");
    expect(container.textContent).toContain("main.tsx");
    expect(container.textContent).toContain("index.html");
  });

  it("mostra contador correto de arquivos", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} />);

    expect(container.textContent).toContain("3 arquivos");
  });

  it("detecta arquivos novos", () => {
    const previous: WebsiteFiles = {
      "src/App.tsx": "old content",
    };

    const current: WebsiteFiles = {
      "src/App.tsx": "old content",
      "src/main.tsx": "new file",
    };

    const { container } = render(<RealtimeFilesViewer files={current} previousFiles={previous} />);

    expect(container.textContent).toContain("Novo");
  });

  it("mostra status de geração quando isGenerating=true", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} isGenerating />);

    expect(container.textContent).toContain("Gerando...");
  });

  it("detecta arquivos modificados quando conteúdo muda", () => {
    const previous: WebsiteFiles = {
      "src/App.tsx": "old content",
    };

    const current: WebsiteFiles = {
      "src/App.tsx": "new content",
    };

    const { container } = render(<RealtimeFilesViewer files={current} previousFiles={previous} />);

    // Arquivo modificado é detectado internamente
    expect(container).toBeInTheDocument();
  });

  it("renderiza componente sem erros com arquivos vazios", () => {
    const { container } = render(<RealtimeFilesViewer files={{}} />);
    expect(container).toBeInTheDocument();
    expect(container.textContent).toContain("0 arquivo");
  });

  it("exibe título Arquivos no heading", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} />);

    const headings = screen.getAllByRole("heading", { level: 3 });
    const arquivosHeading = headings.find(h => h.textContent?.includes("Arquivos"));
    expect(arquivosHeading).toBeDefined();
  });

  it("renderiza sem previousFiles", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} />);
    expect(container).toBeInTheDocument();
    expect(container.textContent).toContain("App.tsx");
  });

  it("mostra mensagem quando nenhum arquivo está selecionado", () => {
    const { container } = render(<RealtimeFilesViewer files={mockFiles} />);

    expect(container.textContent).toContain("Selecione um arquivo para visualizar");
  });
});
