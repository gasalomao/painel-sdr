import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/calendario" }));
vi.mock("next/image", () => ({ default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} /> }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("menu lateral", () => {
  it("recolhe e expande repetidamente com controles e links acessíveis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ authenticated: true, isAdmin: true }) }));
    render(<TooltipProvider><Sidebar /></TooltipProvider>);
    const aside = screen.getByRole("complementary");
    await waitFor(() => expect(within(aside).getByRole("link", { name: "Calendário" })).toBeInTheDocument());
    for (let n = 0; n < 2; n++) {
      fireEvent.click(within(aside).getByRole("button", { name: "Recolher menu" }));
      const expand = within(aside).getByRole("button", { name: "Expandir menu" });
      expect(expand).toHaveAttribute("aria-expanded", "false");
      expect(within(aside).getByRole("link", { name: "Calendário" })).toHaveAttribute("aria-current", "page");
      expect(aside.querySelector("button a, a button")).toBeNull();
      fireEvent.click(expand);
      expect(within(aside).getByRole("button", { name: "Recolher menu" })).toHaveAttribute("aria-expanded", "true");
    }
  });
});
