import { describe, it, expect } from "vitest";
import { checkAntiAIQuality, formatQualityReport } from "../quality-checker";
import type { WebsiteFiles } from "../types";

describe("checkAntiAIQuality", () => {
  describe("Forbidden Gradients", () => {
    it("detecta gradiente roxo-azul proibido", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          .hero {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
        `,
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      expect(report.passed).toBe(false);
      expect(report.score).toBeLessThan(80);

      const gradientCheck = report.checks.find(c => c.id === "no-generic-gradients");
      expect(gradientCheck?.passed).toBe(false);
      expect(gradientCheck?.severity).toBe("critical");
    });

    it("detecta gradiente azul-verde proibido", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          .section {
            background: linear-gradient(to right, #4facfe 0%, #00f2fe 100%);
          }
        `,
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const gradientCheck = report.checks.find(c => c.id === "no-generic-gradients");
      expect(gradientCheck?.passed).toBe(false);
    });

    it("aprova site sem gradientes genéricos", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          .hero {
            background: var(--color-surface-1);
          }
        `,
        "src/tokens.css": `
          :root {
            --color-surface-1: #0a0d12;
            --font-body: system-ui;
            --space-4: 1rem;
          }
        `,
        "src/App.tsx": `
          export default function App() {
            return <button>Agendar Consulta</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const gradientCheck = report.checks.find(c => c.id === "no-generic-gradients");
      expect(gradientCheck?.passed).toBe(true);
    });
  });

  describe("Fluid Typography", () => {
    it("detecta tipografia com tamanhos fixos", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          h1 { font-size: 32px; }
          p { font-size: 16px; }
        `,
        "src/tokens.css": ":root { --color-primary: #000; }",
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const typoCheck = report.checks.find(c => c.id === "fluid-typography");
      expect(typoCheck?.passed).toBe(false);
      expect(typoCheck?.severity).toBe("high");
      expect(typoCheck?.message).toContain("32px");
    });

    it("aprova tipografia fluida com clamp", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          h1 { font-size: clamp(2rem, 5vw, 3rem); }
          p { font-size: clamp(1rem, 2vw, 1.25rem); }
        `,
        "src/tokens.css": `
          :root {
            --font-size-xl: clamp(2rem, 5vw, 3rem);
            --color-primary: #000;
            --space-4: 1rem;
          }
        `,
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const typoCheck = report.checks.find(c => c.id === "fluid-typography");
      expect(typoCheck?.passed).toBe(true);
    });
  });

  describe("CSS Tokens", () => {
    it("detecta ausência de tokens.css", () => {
      const files: WebsiteFiles = {
        "src/App.css": ".hero { background: #000; }",
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const tokenCheck = report.checks.find(c => c.id === "css-tokens");
      expect(tokenCheck?.passed).toBe(false);
      expect(tokenCheck?.severity).toBe("high");
      expect(tokenCheck?.message).toContain("não encontrado");
    });

    it("detecta tokens.css incompleto", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": `
          :root {
            --color-primary: #000;
          }
        `,
        "src/App.css": ".hero { background: var(--color-primary); }",
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const tokenCheck = report.checks.find(c => c.id === "css-tokens");
      expect(tokenCheck?.passed).toBe(false);
      expect(tokenCheck?.message).toContain("faltam");
    });

    it("detecta tokens definidos mas não usados", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": `
          :root {
            --color-primary: #000;
            --font-body: system-ui;
            --space-4: 1rem;
          }
        `,
        "src/App.css": ".hero { background: #000; font-size: 16px; }",
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const tokenCheck = report.checks.find(c => c.id === "css-tokens");
      expect(tokenCheck?.passed).toBe(false);
      expect(tokenCheck?.message).toContain("pouco usados");
    });

    it("aprova tokens completos e usados", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": `
          :root {
            --color-primary: #000;
            --color-surface-1: #0a0d12;
            --font-body: system-ui;
            --font-display: Georgia;
            --space-4: 1rem;
            --space-8: 2rem;
          }
        `,
        "src/App.css": `
          .hero {
            background: var(--color-surface-1);
            color: var(--color-primary);
            font-family: var(--font-display);
            padding: var(--space-8);
            margin: var(--space-4);
          }
        `,
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);

      const tokenCheck = report.checks.find(c => c.id === "css-tokens");
      expect(tokenCheck?.passed).toBe(true);
      expect(tokenCheck?.message).toContain("centralizados e consumidos");
    });
  });

  describe("Generic CTAs", () => {
    it('detecta "Saiba Mais" genérico', () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "button { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return <button>Saiba Mais</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const ctaCheck = report.checks.find(c => c.id === "specific-ctas");
      expect(ctaCheck?.passed).toBe(false);
      expect(ctaCheck?.severity).toBe("high");
      expect(ctaCheck?.message).toContain("Saiba Mais");
    });

    it('detecta "Começar Agora" genérico', () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "button { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return <button>Começar Agora</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const ctaCheck = report.checks.find(c => c.id === "specific-ctas");
      expect(ctaCheck?.passed).toBe(false);
    });

    it("aprova CTAs específicos do negócio", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "button { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return (
              <>
                <button>Agendar Consulta</button>
                <button>Ver Cardápio</button>
                <button>Calcular Frete</button>
              </>
            );
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const ctaCheck = report.checks.find(c => c.id === "specific-ctas");
      expect(ctaCheck?.passed).toBe(true);
    });
  });

  describe("Grid-First Layout", () => {
    it("detecta ausência de CSS Grid", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": `
          .container { display: flex; }
          .section { display: flex; }
        `,
        "src/App.tsx": `
          export default function App() {
            return <button>Agendar Consulta</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const layoutCheck = report.checks.find(c => c.id === "grid-first-layout");
      expect(layoutCheck?.passed).toBe(false);
      expect(layoutCheck?.severity).toBe("medium");
    });

    it("aprova uso de CSS Grid", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": `
          .layout { display: grid; grid-template-columns: 1fr 3fr; }
          .section { display: grid; gap: 2rem; }
        `,
        "src/App.tsx": `
          export default function App() {
            return <button>Agendar Consulta</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const layoutCheck = report.checks.find(c => c.id === "grid-first-layout");
      expect(layoutCheck?.passed).toBe(true);
      expect(layoutCheck?.message).toContain("2 ocorrências");
    });
  });

  describe("Portuguese Content", () => {
    it("detecta lorem ipsum", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "div { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return (
              <div>
                <p>Lorem ipsum dolor sit amet</p>
                <button>Contratar</button>
              </div>
            );
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const contentCheck = report.checks.find(c => c.id === "portuguese-content");
      expect(contentCheck?.passed).toBe(false);
      expect(contentCheck?.severity).toBe("medium");
      expect(contentCheck?.message).toContain("Lorem ipsum");
    });

    it("detecta textos longos em inglês", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "div { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return (
              <div>
                <p>Welcome to our amazing platform where you can do many things</p>
                <button>Start Now</button>
              </div>
            );
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const contentCheck = report.checks.find(c => c.id === "portuguese-content");
      expect(contentCheck?.passed).toBe(false);
      expect(contentCheck?.message).toContain("inglês");
    });

    it("aprova conteúdo em português", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "div { display: grid; }",
        "src/App.tsx": `
          export default function App() {
            return (
              <div>
                <h1>Bem-vindo à Nossa Plataforma</h1>
                <p>Oferecemos soluções personalizadas para seu negócio crescer.</p>
                <button>Agendar Demonstração</button>
              </div>
            );
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      const contentCheck = report.checks.find(c => c.id === "portuguese-content");
      expect(contentCheck?.passed).toBe(true);
    });
  });

  describe("Score Calculation", () => {
    it("calcula score 100 para site perfeito", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": `
          :root {
            --color-surface-1: #0a0d12;
            --color-surface-2: #0f131c;
            --color-primary: #38bdf8;
            --color-text: #e5e7eb;
            --font-display: Georgia;
            --font-body: system-ui;
            --space-2: 0.5rem;
            --space-4: 1rem;
            --space-8: 2rem;
          }
        `,
        "src/App.css": `
          .layout {
            display: grid;
            grid-template-columns: 1fr 3fr;
            background: var(--color-surface-1);
          }
          h1 {
            font-size: clamp(2rem, 5vw, 3rem);
            color: var(--color-primary);
            font-family: var(--font-display);
          }
          p {
            font-size: clamp(1rem, 2vw, 1.25rem);
            color: var(--color-text);
            font-family: var(--font-body);
          }
          .section {
            padding: var(--space-8);
            background: var(--color-surface-2);
            gap: var(--space-4);
          }
          button {
            padding: var(--space-2) var(--space-4);
          }
        `,
        "src/App.tsx": `
          export default function App() {
            return (
              <div>
                <h1>Consultoria Empresarial Especializada</h1>
                <p>Ajudamos sua empresa a crescer com estratégias personalizadas.</p>
                <button>Agendar Consultoria Gratuita</button>
              </div>
            );
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      expect(report.score).toBe(100);
      expect(report.passed).toBe(true);
      expect(report.checks.every(c => c.passed)).toBe(true);
    });

    it("bloqueia site com múltiplas falhas críticas", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          .hero {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-size: 16px;
          }
        `,
        "src/App.tsx": `
          export default function App() {
            return <button>Saiba Mais</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);

      expect(report.score).toBeLessThan(50);
      expect(report.passed).toBe(false);
      expect(report.summary).toContain("BLOQUEADO");
    });
  });

  describe("formatQualityReport", () => {
    it("formata relatório com falhas", () => {
      const files: WebsiteFiles = {
        "src/App.css": `
          .hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        `,
        "src/App.tsx": "export default function App() { return <div>Test</div>; }",
      };

      const report = checkAntiAIQuality(files);
      const formatted = formatQualityReport(report);

      expect(formatted).toContain("RELATÓRIO DE QUALIDADE ANTI-IA");
      expect(formatted).toContain("Score:");
      expect(formatted).toContain("🔴 CHECKS CRÍTICOS");
      expect(formatted).toContain("gradiente");
    });

    it("formata relatório aprovado", () => {
      const files: WebsiteFiles = {
        "src/tokens.css": ":root { --color-primary: #000; --font-body: sans-serif; --space-4: 1rem; }",
        "src/App.css": "div { display: grid; font-size: clamp(1rem, 2vw, 1.5rem); color: var(--color-primary); }",
        "src/App.tsx": `
          export default function App() {
            return <button>Agendar Consulta</button>;
          }
        `,
      };

      const report = checkAntiAIQuality(files);
      const formatted = formatQualityReport(report);

      expect(formatted).toContain("✅ Site aprovado");
      expect(formatted).toContain("✓");
    });
  });
});
