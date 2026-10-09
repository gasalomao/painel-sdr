import { DESIGN_DIRECTION_FIELDS, impeccableReference, parseWebsiteDesignDirection, type WebsiteDesignDirection } from "./impeccable";
import type { WebsiteAsset, WebsiteFiles } from "./types";
import { siteAssetPublicPath } from "./asset-preview";
import { normalizeWebsitePath, validateFiles, validateWebsiteContent, WEBSITE_LIMITS } from "./validation";

const READ_RESULT_BYTES = 30_000;
const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const splitsSurrogate = (content: string, offset: number): boolean => offset > 0 && offset < content.length && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset]);
const string = { type: "string" };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
  ["read_design_reference", "Lê uma referência oficial integral do Impeccable em blocos; consulte o catálogo no prompt. Disponível somente quando a skill está ativa.", { name: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, ["name"]],
  ["record_design_direction", "Registra a direção de design privada antes de construir; não cria arquivo publicável. Inclua decisões específicas do briefing em cada campo.", { mode: { type: "string", enum: ["persuade", "operate", "read", "experience"] }, ...Object.fromEntries(DESIGN_DIRECTION_FIELDS.map((field) => [field, { type: "string", minLength: 8, maxLength: 1200 }])) }, ["mode", ...DESIGN_DIRECTION_FIELDS]],
  ["list", "Lista os arquivos virtuais.", {}, []],
  ["read", "Lê linhas numeradas de um arquivo (start_line/end_line, iniciando em 1). Para erros de compilador use a linha exata, nunca estime caracteres. offset/limit em caracteres apenas quando explicitamente necessários.", { path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 30000 }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, ["path"]],
  ["read_files", "Lê até 8 arquivos virtuais.", { paths: { type: "array", items: string, maxItems: 8 } }, ["paths"]],
  ["create", "Cria um arquivo editável inexistente.", { path: string, content: string }, ["path", "content"]],
  ["write", "Substitui um arquivo editável existente.", { path: string, content: string }, ["path", "content"]],
  ["patch", "Substitui um trecho literal único no arquivo (ideal para trocar cores, textos e estilos pontuais com economia máxima de tokens; inclua 1 linha de contexto se necessário para garantir unicidade).", { path: string, old: string, new: string }, ["path", "old", "new"]],
  ["delete", "Exclui um arquivo editável.", { path: string }, ["path"]],
  ["rename", "Renomeia sem sobrescrever o destino.", { path: string, to: string }, ["path", "to"]],
  ["search", "Busca texto literal e retorna arquivo/linha; path opcional restringe a um arquivo. Máximo 40 resultados.", { query: string, path: string }, ["query"]],
  ["get_context", "Retorna somente contexto confirmado do projeto.", {}, []],
  ["assets", "Lista metadados dos assets selecionados; nunca segredos.", {}, []],
  ["checkpoint", "Salva checkpoint temporário nomeado do workspace.", { name: string }, ["name"]],
  ["restore", "Restaura checkpoint temporário; initial preserva o estado inicial.", { name: string }, ["name"]],
  ["run_validation", "Valida estaticamente o workspace. Build e visual acontecem isolados após a edição.", {}, []],
];

const ALL_WEBSITE_TOOLS = definitions.map(([name, description, properties, required]) => ({ type: "function" as const, function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }));

export const WEBSITE_TOOLS = ALL_WEBSITE_TOOLS.filter((tool) => !["read_design_reference", "record_design_direction"].includes(tool.function.name));

const PATCH_ONLY_BLOCKED = ["create", "write", "delete", "rename", "restore", "record_design_direction"];

/** Map LF offsets back to original bytes; only the matched range changes. */
function patchText(current: string, old: string, replacement: string): string {
  const source = current.replace(/\r\n/g, "\n");
  const search = old.replace(/\r\n/g, "\n");
  const index = source.indexOf(search);
  if (!search || index < 0 || index !== source.lastIndexOf(search)) throw new Error("Trecho ausente ou ambíguo.");
  const originalOffset = (offset: number): number => {
    let original = 0;
    for (let normalized = 0; normalized < offset; normalized++, original++) {
      if (current[original] === "\r" && current[original + 1] === "\n") original++;
    }
    return original;
  };
  const start = originalOffset(index);
  const end = originalOffset(index + search.length);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const next = current.slice(0, start) + replacement.replace(/\r\n/g, "\n").replace(/\n/g, newline) + current.slice(end);
  if (next === current) throw new Error("Patch não altera o arquivo.");
  return next;
}

function text(args: Record<string, unknown>, key: string, empty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!empty && !value.length)) throw new Error(`Argumento inválido: ${key}`);
  return value;
}

export class WebsiteTools {
  private workspace: WebsiteFiles;
  private checkpoints = new Map<string, WebsiteFiles>();
  private direction: WebsiteDesignDirection | undefined;

  constructor(files: WebsiteFiles, private readonly data: { context: object; assets: WebsiteAsset[]; patchOnly?: boolean; impeccable?: boolean; requireDesignDirection?: boolean; designDirection?: WebsiteDesignDirection }) {
    validateFiles(files);
    this.direction = data.designDirection ? parseWebsiteDesignDirection(data.designDirection) : undefined;
    this.workspace = { ...files };
    this.checkpoints.set("initial", { ...files });
  }

  get files(): WebsiteFiles { return { ...this.workspace }; }
  get designDirection(): WebsiteDesignDirection | undefined { return this.direction ? { ...this.direction } : undefined; }
  get patchOnly(): boolean { return this.data.patchOnly === true; }
  get definitions(): typeof WEBSITE_TOOLS {
    const available = this.data.impeccable ? ALL_WEBSITE_TOOLS : WEBSITE_TOOLS;
    return this.patchOnly ? available.filter((tool) => !PATCH_ONLY_BLOCKED.includes(tool.function.name)) : available;
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    if (this.patchOnly && PATCH_ONLY_BLOCKED.includes(name)) throw new Error("Edição pontual permite somente patch; reescrita não autorizada.");
    const definition = definitions.find(([tool]) => tool === name);
    if (!definition || (!this.data.impeccable && ["read_design_reference", "record_design_direction"].includes(name))) throw new Error("Ferramenta não permitida.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Argumentos inválidos.");
    if (this.data.requireDesignDirection && !this.direction && ["create", "write", "patch", "delete", "rename"].includes(name)) throw new Error("Antes de construir, registre a direção específica com record_design_direction.");
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some((key) => !Object.hasOwn(definition[2], key))) throw new Error("Argumentos inesperados.");
    const read = (path: string): string => {
      if (!Object.hasOwn(this.workspace, path)) throw new Error("Arquivo inexistente.");
      return this.workspace[path];
    };
    let result: unknown;
    switch (name) {
      case "read_design_reference": {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 12000;
        if (!Number.isInteger(offset) || !Number.isInteger(limit) || Number(offset) < 0 || Number(limit) < 1 || Number(limit) > 20000) throw new Error("Intervalo inválido.");
        const content = impeccableReference(text(args, "name"));
        result = { content: content.slice(Number(offset), Number(offset) + Number(limit)), total: content.length, nextOffset: Number(offset) + Number(limit) < content.length ? Number(offset) + Number(limit) : null };
        break;
      }
      case "record_design_direction": {
        this.direction = parseWebsiteDesignDirection(args);
        result = { recorded: true, direction: this.direction };
        break;
      }
      case "list": result = Object.keys(this.workspace).sort(); break;
      case "read": {
        const path = text(args, "path");
        const content = read(path);
        for (const key of ["offset", "limit", "start_line", "end_line"]) {
          if (args[key] !== undefined && !Number.isSafeInteger(args[key])) throw new Error("Intervalo inválido.");
        }
        const characters = args.offset !== undefined || args.limit !== undefined;
        if (characters && (args.start_line !== undefined || args.end_line !== undefined)) throw new Error("Intervalo inválido: use linhas ou caracteres, não ambos.");
        if (!characters) {
          if (args.end_line !== undefined && args.start_line === undefined) throw new Error("Intervalo inválido: informe start_line.");
          const start = args.start_line ?? 1;
          const end = args.end_line ?? Number(start) + 99;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 1 || Number(end) < Number(start)) throw new Error("Intervalo de linhas inválido.");
          const lines = content.split(/\r?\n/);
          if (Number(start) > lines.length) throw new Error("Intervalo de linhas inválido: além do fim do arquivo.");
          const selected: string[] = [];
          const page = (text: string, actualEnd: number) => ({ content: text, start_line: start, end_line: actualEnd, total_lines: lines.length, next_line: actualEnd < lines.length ? actualEnd + 1 : null });
          const last = Math.min(lines.length, Number(end), Number(start) + 199);
          for (let index = Number(start) - 1; index < last; index++) {
            const line = `${index + 1}: ${lines[index]}`;
            if (encodedBytes(page([...selected, line].join("\n"), index + 1)) > READ_RESULT_BYTES) break;
            selected.push(line);
          }
          if (!selected.length) throw new Error("Linha excede o limite. Use offset/limit em caracteres.");
          result = page(selected.join("\n"), Number(start) + selected.length - 1);
        } else {
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 30_000;
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || Number(offset) < 0 || Number(offset) > content.length || Number(limit) < 1 || Number(limit) > 30_000 || splitsSurrogate(content, Number(offset))) throw new Error("Intervalo inválido.");
          const start = Number(offset);
          const totalLines = content.split("\n").length;
          const page = (end: number) => ({ content: content.slice(start, end), total: content.length, total_lines: totalLines, next_offset: end < content.length ? end : null });
          let low = start;
          let high = start + Math.min(content.length - start, Number(limit));
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (encodedBytes(page(middle)) <= READ_RESULT_BYTES) low = middle;
            else high = middle - 1;
          }
          let end = splitsSurrogate(content, low) ? low - 1 : low;
          // A one-unit limit may expand to one complete code point, never a broken surrogate.
          if (end === start && start < content.length && splitsSurrogate(content, start + 1)) end = start + 2;
          result = page(end);
        }
        break;
      }
      case "read_files": {
        if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 8 || args.paths.some((path) => typeof path !== "string")) throw new Error("Lista inválida.");
        result = Object.fromEntries(args.paths.map((path: string) => [path, read(path)]));
        break;
      }
      case "search": {
        const query = text(args, "query");
        if (query.length > 500) throw new Error("Busca muito longa.");
        const target = args.path === undefined ? undefined : normalizeWebsitePath(text(args, "path"));
        if (target) read(target);
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const [path, content] of Object.entries(this.workspace)) {
          if (target && path !== target) continue;
          for (const [line, value] of content.split(/\r?\n/).entries()) {
            if (value.includes(query) && matches.length < 40) matches.push({ path, line: line + 1, text: value.slice(0, 500) });
          }
        }
        result = matches;
        break;
      }
      case "get_context": result = this.data.context; break;
      case "assets": result = this.data.assets.map((asset) => {
        let public_path: string | null = null;
        try { public_path = siteAssetPublicPath(asset); } catch { /* ignore */ }
        return { id: asset.id, name: asset.name, mime: asset.mime, purpose: asset.purpose, width: asset.width, height: asset.height, public_path };
      }); break;
      case "checkpoint": {
        const key = text(args, "name");
        if (!/^[a-zA-Z0-9_-]{1,60}$/.test(key) || key === "initial" || this.checkpoints.size >= 6) throw new Error("Checkpoint inválido ou limite excedido.");
        this.checkpoints.set(key, { ...this.workspace });
        result = { checkpoint: key };
        break;
      }
      case "restore": {
        const files = this.checkpoints.get(text(args, "name"));
        if (!files) throw new Error("Checkpoint inexistente.");
        this.workspace = { ...files };
        result = { restored: true };
        break;
      }
      case "run_validation": result = { ...validateWebsiteContent(this.workspace), scope: "static", build: "pending", visual: "pending" }; break;
      default: {
        const path = normalizeWebsitePath(text(args, "path"));
        const next = { ...this.workspace };
        const cleanJsx = (val: string): string => /\.(tsx|jsx)$/.test(path) ? val.replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}") : val;
        if (name === "create") {
          if (Object.hasOwn(next, path)) throw new Error("Arquivo já existe.");
          next[path] = cleanJsx(text(args, "content", true));
        } else {
          const current = read(path);
          if (name === "write") next[path] = cleanJsx(text(args, "content", true));
          if (name === "delete") delete next[path];
          if (name === "rename") {
            const to = normalizeWebsitePath(text(args, "to"));
            if (Object.hasOwn(next, to)) throw new Error("Destino já existe.");
            next[to] = current;
            delete next[path];
          }
          if (name === "patch") {
            const old = text(args, "old");
            const newText = cleanJsx(text(args, "new", true));
            next[path] = patchText(current, old, newText);
          }
        }
        validateFiles(next);
        this.workspace = next;
        result = { saved: path };
      }
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > WEBSITE_LIMITS.toolResultBytes) throw new Error("Resposta excede o limite. Leia arquivos individualmente com offset/limit.");
    return result;
  }
}
