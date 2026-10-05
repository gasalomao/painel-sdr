import type { WebsiteAsset, WebsiteFiles } from "./types";
import { normalizeWebsitePath, validateFiles, validateWebsiteContent, WEBSITE_LIMITS } from "./validation";

const string = { type: "string" };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
  ["list", "Lista os arquivos virtuais.", {}, []],
  ["read", "Lê um arquivo virtual, com offset/limit em caracteres.", { path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 30000 } }, ["path"]],
  ["read_files", "Lê até 8 arquivos virtuais.", { paths: { type: "array", items: string, maxItems: 8 } }, ["paths"]],
  ["create", "Cria um arquivo editável inexistente.", { path: string, content: string }, ["path", "content"]],
  ["write", "Substitui um arquivo editável existente.", { path: string, content: string }, ["path", "content"]],
  ["patch", "Substitui um trecho literal único. Não é regex.", { path: string, old: string, new: string }, ["path", "old", "new"]],
  ["delete", "Exclui um arquivo editável.", { path: string }, ["path"]],
  ["rename", "Renomeia sem sobrescrever o destino.", { path: string, to: string }, ["path", "to"]],
  ["search", "Busca texto literal nos arquivos virtuais; máximo 40 resultados.", { query: string }, ["query"]],
  ["get_context", "Retorna somente contexto confirmado do projeto.", {}, []],
  ["assets", "Lista metadados dos assets selecionados; nunca segredos.", {}, []],
  ["checkpoint", "Salva checkpoint temporário nomeado do workspace.", { name: string }, ["name"]],
  ["restore", "Restaura checkpoint temporário; initial preserva o estado inicial.", { name: string }, ["name"]],
  ["run_validation", "Valida estaticamente o workspace. Build e visual acontecem isolados após a edição.", {}, []],
];

export const WEBSITE_TOOLS = definitions.map(([name, description, properties, required]) => ({ type: "function" as const, function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }));

function text(args: Record<string, unknown>, key: string, empty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!empty && !value.length)) throw new Error(`Argumento inválido: ${key}`);
  return value;
}

export class WebsiteTools {
  private workspace: WebsiteFiles;
  private checkpoints = new Map<string, WebsiteFiles>();

  constructor(files: WebsiteFiles, private readonly data: { context: object; assets: WebsiteAsset[] }) {
    validateFiles(files);
    this.workspace = { ...files };
    this.checkpoints.set("initial", { ...files });
  }

  get files(): WebsiteFiles { return { ...this.workspace }; }

  async execute(name: string, input: unknown): Promise<unknown> {
    const definition = definitions.find(([tool]) => tool === name);
    if (!definition) throw new Error("Ferramenta não permitida.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Argumentos inválidos.");
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some((key) => !Object.hasOwn(definition[2], key))) throw new Error("Argumentos inesperados.");
    const read = (path: string): string => {
      if (!Object.hasOwn(this.workspace, path)) throw new Error("Arquivo inexistente.");
      return this.workspace[path];
    };
    let result: unknown;
    switch (name) {
      case "list": result = Object.keys(this.workspace).sort(); break;
      case "read": {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 30_000;
        if (!Number.isInteger(offset) || !Number.isInteger(limit) || Number(offset) < 0 || Number(limit) < 1 || Number(limit) > 30_000) throw new Error("Intervalo inválido.");
        const content = read(text(args, "path"));
        result = { content: content.slice(Number(offset), Number(offset) + Number(limit)), total: content.length };
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
        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const [path, content] of Object.entries(this.workspace)) {
          for (const [line, value] of content.split("\n").entries()) {
            if (value.includes(query) && matches.length < 40) matches.push({ path, line: line + 1, text: value.slice(0, 500) });
          }
        }
        result = matches;
        break;
      }
      case "get_context": result = this.data.context; break;
      case "assets": result = this.data.assets.map(({ id, name, mime, purpose, width, height }) => ({ id, name, mime, purpose, width, height })); break;
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
      case "run_validation": result = validateWebsiteContent(this.workspace); break;
      default: {
        const path = normalizeWebsitePath(text(args, "path"));
        const next = { ...this.workspace };
        if (name === "create") {
          if (Object.hasOwn(next, path)) throw new Error("Arquivo já existe.");
          next[path] = text(args, "content", true);
        } else {
          const current = read(path);
          if (name === "write") next[path] = text(args, "content", true);
          if (name === "delete") delete next[path];
          if (name === "rename") {
            const to = normalizeWebsitePath(text(args, "to"));
            if (Object.hasOwn(next, to)) throw new Error("Destino já existe.");
            next[to] = current;
            delete next[path];
          }
          if (name === "patch") {
            const old = text(args, "old");
            if (!current.includes(old) || current.indexOf(old) !== current.lastIndexOf(old)) throw new Error("Trecho ausente ou ambíguo.");
            next[path] = current.replace(old, () => text(args, "new", true));
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
