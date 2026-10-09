import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DownloadZipButton } from "../download-zip-button";

// Mock do JSZip
vi.mock("jszip", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      file: vi.fn(),
      generateAsync: vi.fn().mockResolvedValue(new Blob(["mock-zip-content"])),
    })),
  };
});

// Mock do sonner toast
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock do window.URL.createObjectURL
global.URL.createObjectURL = vi.fn(() => "mock-blob-url");
global.URL.revokeObjectURL = vi.fn();

const mockFiles = {
  "index.html": "<!DOCTYPE html><html><body>Test</body></html>",
  "styles.css": "body { margin: 0; }",
  "script.js": "console.log('test');",
};

describe("DownloadZipButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renderiza componente sem erros", () => {
    const { container } = render(<DownloadZipButton files={mockFiles} projectName="test-project" />);
    expect(container).toBeInTheDocument();
  });

  it("renderiza ícone de download", () => {
    const { container } = render(<DownloadZipButton files={mockFiles} projectName="test-project" />);

    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("renderiza botão habilitado quando há arquivos", () => {
    render(<DownloadZipButton files={mockFiles} projectName="test-project" />);

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("aceita arquivos como prop", () => {
    const customFiles = {
      "custom.html": "<html></html>",
    };

    const { container } = render(<DownloadZipButton files={customFiles} projectName="test" />);
    expect(container).toBeInTheDocument();
  });

  it("aceita nome do projeto como prop", () => {
    const { container } = render(<DownloadZipButton files={mockFiles} projectName="meu-projeto" />);
    expect(container).toBeInTheDocument();
  });

  it("renderiza com arquivos vazios", () => {
    const { container } = render(<DownloadZipButton files={{}} projectName="empty" />);
    expect(container).toBeInTheDocument();
  });

  it("renderiza com múltiplos arquivos", () => {
    const manyFiles = {
      "file1.html": "content1",
      "file2.css": "content2",
      "file3.js": "content3",
      "file4.ts": "content4",
    };

    const { container } = render(<DownloadZipButton files={manyFiles} projectName="many" />);
    expect(container).toBeInTheDocument();
  });
});
