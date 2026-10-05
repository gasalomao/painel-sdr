import { WEBSITE_FIXED_FILES } from "./starter";
import type { WebsiteFiles, WebsiteQa } from "./types";

export const WEBSITE_LIMITS = Object.freeze({ files: 100, fileBytes: 256_000, totalBytes: 2_000_000, toolResultBytes: 64_000 });

export function normalizeWebsitePath(path: string): string {
  if (typeof path !== "string" || path.length > 180 || path !== path.trim() || /[\\%:\s\x00-\x1f\x7f]/.test(path)) throw new Error("Caminho inválido.");
  const parts = path.split("/");
  if (parts.some((part) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part.endsWith(".") || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("Caminho inválido.");
  if (path === "index.html") return path;
  if (parts.length < 2 || !["src", "public"].includes(parts[0])) throw new Error("Caminho fora do workspace permitido.");
  if (/^(?:assets|functions|_worker\.js|_headers|_redirects)$/i.test(parts[1])) throw new Error("Caminho reservado do sistema de publicação.");
  if (parts.some((part) => /^(?:node_modules|package(?:-lock)?\.json|.*\.config\.[^.]+|tsconfig.*\.json)$/i.test(part))) throw new Error("Configuração imutável.");
  const extension = path.split(".").pop() || "";
  const allowed = parts[0] === "src" ? ["ts", "tsx", "js", "jsx", "css", "json", "svg"] : ["svg", "txt", "json", "css"];
  if (!allowed.includes(extension)) throw new Error("Tipo de arquivo não permitido.");
  return path;
}

function importEscapesSource(fromPath: string, specifier: string): boolean {
  if (specifier.startsWith("/")) return true;
  const segments = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") { if (!segments.pop()) return true; continue; }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  return resolved !== "src" && !resolved.startsWith("src/");
}

export function validateFiles(files: WebsiteFiles): void {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("Mapa de arquivos inválido.");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > WEBSITE_LIMITS.files) throw new Error("Limite de arquivos excedido.");
  for (const [path, content] of Object.entries(WEBSITE_FIXED_FILES)) {
    if (!Object.hasOwn(files, path) || files[path] !== content) throw new Error(`Configuração imutável: ${path}`);
  }
  const paths = new Set<string>();
  let bytes = 0;
  for (const [path, content] of entries) {
    if (!Object.hasOwn(WEBSITE_FIXED_FILES, path)) normalizeWebsitePath(path);
    if (paths.has(path.toLowerCase())) throw new Error("Caminhos ambíguos.");
    paths.add(path.toLowerCase());
    if (typeof content !== "string" || content.includes("\0")) throw new Error("Conteúdo inválido.");
    const size = new TextEncoder().encode(content).length;
    if (size > WEBSITE_LIMITS.fileBytes) throw new Error(`Arquivo excede o limite: ${path}`);
    bytes += size;
  }
  if (bytes > WEBSITE_LIMITS.totalBytes) throw new Error("Workspace excede o limite.");
}

export function validateWebsiteContent(files: WebsiteFiles): WebsiteQa {
  const errors: string[] = [];
  const warnings: string[] = [];
  try { validateFiles(files); } catch (error) { errors.push(error instanceof Error ? error.message : "Arquivos inválidos."); }
  for (const path of ["index.html", "src/main.tsx", "src/App.tsx"]) {
    if (!files[path]?.trim()) errors.push(`Arquivo obrigatório ausente: ${path}`);
  }
  const html = files["index.html"] || "";
  if (!/name=["']viewport["']/.test(html)) errors.push("Meta viewport ausente.");
  if (!/<html\b[^>]*lang=["'][^"']+["']/.test(html)) errors.push("Idioma do documento ausente.");
  for (const [path, content] of Object.entries(files)) {
    if (Object.hasOwn(WEBSITE_FIXED_FILES, path)) continue;
    if (/\b(?:eval|Function)\s*\(|\b(?:process\.env|child_process|Deno\.|Bun\.)|\bimport\s*\(\s*[^"'\s]/.test(content)) errors.push(`Código não permitido: ${path}`);
    if (/<(?:iframe|object|embed|base)\b|javascript\s*:|<script\b[^>]*src=["']https?:/i.test(content)) errors.push(`Conteúdo ativo externo não permitido: ${path}`);
    if (/\.(?:tsx?|jsx?)$/.test(path)) {
      const imports = content.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g);
      for (const match of imports) {
        const specifier = match[1];
        if (!/^\.{1,2}\//.test(specifier)) {
          if (!/^(?:react(?:\/jsx(?:-dev)?-runtime)?|react-dom(?:\/client)?)$/.test(specifier)) errors.push(`Dependência não autorizada em ${path}: ${specifier}`);
          continue;
        }
        if (/[?#]/.test(specifier) || importEscapesSource(path, specifier)) errors.push(`Import fora do workspace em ${path}: ${specifier}`);
      }
    }
    if (path.endsWith(".svg") && /<script\b|\bon\w+\s*=|foreignObject/i.test(content)) errors.push(`SVG ativo não permitido: ${path}`);
    if (/lorem ipsum|placeholder\.com|example\.com/i.test(content)) warnings.push(`Revisar conteúdo provisório: ${path}`);
  }
  return { passed: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
