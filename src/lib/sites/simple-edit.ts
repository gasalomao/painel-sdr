import ts from "typescript";
import type { WebsiteFiles } from "./types";

export function literalWebsiteTextEdit(prompt: string, files: WebsiteFiles): { path: string; old: string; new: string } | undefined {
  // ponytail: only quoted, whole JSX text nodes; attributes/data/ambiguous edits use the model.
  const match = /^(?:troque|substitua|altere)\s+(?:o\s+)?texto\s+["“]([^"”\r\n]{1,200})["”]\s+por\s+["“]([^"”\r\n]{1,200})["”]\s*[.!]?$/i.exec(prompt.trim());
  if (!match || match[1] === match[2] || /[<>{}&\\]/.test(match[1] + match[2])) return;
  const [, old, replacement] = match;
  const occurrences = Object.values(files).reduce((count, content) => count + content.split(old).length - 1, 0);
  if (occurrences !== 1) return;
  for (const [path, content] of Object.entries(files)) {
    if (!/^src\/.*\.(?:tsx|jsx)$/.test(path) || !content.includes(old)) continue;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true);
    let displayed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && node.getText(source) === old) displayed = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (displayed) return { path, old, new: replacement };
  }
}
