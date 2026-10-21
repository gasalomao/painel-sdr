import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LeadAvatar, safePhotoUrl, getInitials } from "../lead-avatar";

class MockImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  referrerPolicy = "";
  crossOrigin: string | null = null;
  private _src = "";

  set src(val: string) {
    this._src = val;
    setTimeout(() => {
      this.onload?.();
    }, 0);
  }

  get src() {
    return this._src;
  }
}

describe("LeadAvatar helper functions", () => {
  it("extrai iniciais corretamente com 1 palavra, 2+ palavras e vazios", () => {
    expect(getInitials("Auto Mecânica Silva")).toBe("AM");
    expect(getInitials("Padaria")).toBe("PA");
    expect(getInitials("")).toBe("L");
    expect(getInitials(null)).toBe("L");
  });

  it("valida URLs seguras e rejeita esquemas inseguros ou strings inválidas", () => {
    expect(safePhotoUrl("https://pps.whatsapp.net/v/avatar.jpg")).toBe("https://pps.whatsapp.net/v/avatar.jpg");
    expect(safePhotoUrl("http://localhost:3000/photo.png")).toBeNull();
    expect(safePhotoUrl("https://evil.test/photo.png")).toBeNull();
    expect(safePhotoUrl("https://pps.whatsapp.net/photo.jpg?oe=5E0BE100")).toBeNull();
    expect(safePhotoUrl("javascript:alert(1)")).toBeNull();
    expect(safePhotoUrl("data:text/html,bad")).toBeNull();
    expect(safePhotoUrl("")).toBeNull();
    expect(safePhotoUrl(null)).toBeNull();
    expect(safePhotoUrl(123)).toBeNull();
  });
});

describe("LeadAvatar component", () => {
  const originalImage = window.Image;

  beforeEach(() => {
    // @ts-expect-error Mock Image for jsdom
    window.Image = MockImage;
  });

  afterEach(() => {
    window.Image = originalImage;
    cleanup();
  });

  it("renderiza fallback com iniciais quando URL não for fornecida", () => {
    render(<LeadAvatar name="Borracharia Central" />);
    expect(screen.getByText("BC")).toBeInTheDocument();
  });

  it("renderiza fallback quando URL for insegura ou vazia", () => {
    render(<LeadAvatar name="Clínica Sorriso" url="javascript:bad" />);
    expect(screen.getByText("CS")).toBeInTheDocument();
  });

  it("volta às iniciais se a imagem falhar e tenta novamente quando a URL mudar", async () => {
    const { rerender } = render(<LeadAvatar name="Auto Mecânica" url="https://pps.whatsapp.net/old.jpg" />);
    const img = await screen.findByRole("img", { name: "Auto Mecânica" });
    fireEvent.error(img);
    await waitFor(() => expect(screen.queryByRole("img", { name: "Auto Mecânica" })).not.toBeInTheDocument());
    expect(screen.getByText("AM")).toBeInTheDocument();
    rerender(<LeadAvatar name="Auto Mecânica" url="https://pps.whatsapp.net/new.jpg" />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Auto Mecânica" })).toHaveAttribute("src", "https://pps.whatsapp.net/new.jpg"));
  });

  it("renderiza imagem com referrerPolicy no-referrer e lazy loading quando URL for válida", async () => {
    render(<LeadAvatar name="Auto Mecânica" url="https://pps.whatsapp.net/avatar.jpg" />);
    await waitFor(() => {
      const img = screen.getByRole("img", { name: "Auto Mecânica" });
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("src", "https://pps.whatsapp.net/avatar.jpg");
      expect(img).toHaveAttribute("referrerPolicy", "no-referrer");
      expect(img).toHaveAttribute("loading", "lazy");
    });
  });
});
