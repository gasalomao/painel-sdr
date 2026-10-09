import { describe, expect, it } from "vitest";
import { literalWebsiteTextEdit } from "../simple-edit";
import { getStarterFiles } from "../starter";

const files = { ...getStarterFiles(), "src/App.tsx": 'export default function App(){return <h1>Tudo para o campo</h1>;}' };

describe("literal displayed text edits", () => {
  it("edits a unique JSX text without changing other bytes", () => {
    expect(literalWebsiteTextEdit('Troque o texto "Tudo para o campo" por "Casa do Agricultor".', files)).toEqual({ path: "src/App.tsx", old: "Tudo para o campo", new: "Casa do Agricultor" });
  });

  it.each([
    'Troque o texto "Tudo para o campo" por "<img>"',
    'Troque o texto "Tudo para o campo" por "{secret}"',
    'Troque o texto "Tudo para o campo" por "A & B"',
    'Troque tudo para Casa do Agricultor',
    'Troque o texto "Tudo para o campo" por "Tudo para o campo"',
  ])("keeps ambiguous or code-shaped requests on the model path: %s", (prompt) => {
    expect(literalWebsiteTextEdit(prompt, files)).toBeUndefined();
  });

  it("does not edit strings, attributes, URLs or duplicate content", () => {
    const prompt = 'Troque o texto "Tudo para o campo" por "Casa do Agricultor"';
    for (const app of [
      'const label = "Tudo para o campo"; export default function App(){return <h1>{label}</h1>;}',
      'export default function App(){return <h1 title="Tudo para o campo">Título</h1>;}',
      'export default function App(){return <><h1>Tudo para o campo</h1><p>Tudo para o campo</p></>;}',
    ]) expect(literalWebsiteTextEdit(prompt, { ...files, "src/App.tsx": app })).toBeUndefined();
  });
});
