import { posix } from "node:path";
import ts from "typescript";
import type { WebsiteFiles } from "./types";

export function websiteSyntaxErrors(files: WebsiteFiles): string[] {
  const errors: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(?:tsx?|jsx?)$/.test(path) || path.endsWith(".d.ts") || !path.startsWith("src/")) continue;
    // Only parse virtual text. Never load project configs, plugins or execute emitted code.
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true);
    const host: ts.CompilerHost = {
      getSourceFile: (name) => name === path ? source : undefined,
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile: () => { throw new Error("Emissão não permitida no diagnóstico."); },
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => name === path,
      readFile: (name) => name === path ? content : undefined,
    };
    const checkImport = (node: ts.Node): void => {
      // Small React contract check, not a substitute for the isolated TypeScript build.
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && /^[a-z][a-zA-Z0-9]*$/.test(node.tagName.text)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue;
          const replacement = attribute.name.text === "class" ? "className" : attribute.name.text === "for" ? "htmlFor" : undefined;
          if (replacement && errors.length < 8) {
            const { line, character } = source.getLineAndCharacterOfPosition(attribute.getStart(source));
            errors.push(`${path}(${line + 1},${character + 1}): Atributo React inválido: ${attribute.name.text}. Use ${replacement}.`);
          }
        }
      }
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && /^\.{1,2}\//.test(specifier.text)) {
        const resolved = ts.resolveModuleName(specifier.text, path, { moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, allowJs: true }, {
          fileExists: (name) => Object.hasOwn(files, name),
          readFile: (name) => files[name],
        }).resolvedModule;
        const literalPath = posix.normalize(posix.join(posix.dirname(path), specifier.text));
        if (!resolved && !Object.hasOwn(files, literalPath) && errors.length < 8) {
          const { line, character } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
          errors.push(`${path}(${line + 1},${character + 1}): Import local inexistente: ${specifier.text}`);
        }
      }
      ts.forEachChild(node, checkImport);
    };
    checkImport(source);
    const program = ts.createProgram([path], { noEmit: true, noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.ReactJSX }, host);
    for (const diagnostic of program.getSyntacticDiagnostics(source).slice(0, 8)) {
      const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const lines = content.split(/\r?\n/);
      const context = lines.slice(Math.max(0, line - 2), line + 3).map((value, index) => `${Math.max(0, line - 2) + index + 1}: ${value.slice(0, 300)}`).join("\n");
      errors.push(`${path}(${line + 1},${character + 1}): TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 500)}\n${context}`);
      if (errors.length >= 8) return errors;
    }
  }
  return errors;
}
