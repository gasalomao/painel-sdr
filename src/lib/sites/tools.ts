import { DESIGN_DIRECTION_FIELDS, impeccableReference, parseWebsiteDesignDirection, type WebsiteDesignDirection } from "./impeccable";
import type { WebsiteAsset, WebsiteFiles } from "./types";
import { siteAssetPublicPath } from "./asset-preview";
import { normalizeWebsitePath, validateFiles, validateWebsiteContent, WEBSITE_LIMITS } from "./validation";

const string = { type: "string" };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> = [
  ["read_design_reference", "Lê uma referência oficial integral do Impeccable em blocos; consulte o catálogo no prompt. Disponível somente quando a skill está ativa.", { name: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20000 } }, ["name"]],
  ["record_design_direction", "Registra a direção de design privada antes de construir; não cria arquivo publicável. Inclua decisões específicas do briefing em cada campo.", { mode: { type: "string", enum: ["persuade", "operate", "read", "experience"] }, ...Object.fromEntries(DESIGN_DIRECTION_FIELDS.map((field) => [field, { type: "string", minLength: 8, maxLength: 1200 }])) }, ["mode", ...DESIGN_DIRECTION_FIELDS]],
  ["list", "Lista os arquivos virtuais.", {}, []],
  ["read", "Lê um arquivo virtual, com offset/limit em caracteres.", { path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 30000 } }, ["path"]],
  ["read_files", "Lê até 8 arquivos virtuais.", { paths: { type: "array", items: string, maxItems: 8 } }, ["paths"]],
  ["create", "Cria um arquivo editável inexistente.", { path: string, content: string }, ["path", "content"]],
  ["write", "Substitui um arquivo editável existente.", { path: string, content: string }, ["path", "content"]],
  ["patch", "Substitui um trecho literal único no arquivo (ideal para trocar cores, textos e estilos pontuais com economia máxima de tokens; inclua 1 linha de contexto se necessário para garantir unicidade).", { path: string, old: string, new: string }, ["path", "old", "new"]],
  ["delete", "Exclui um arquivo editável.", { path: string }, ["path"]],
  ["rename", "Renomeia sem sobrescrever o destino.", { path: string, to: string }, ["path", "to"]],
  ["search", "Busca texto literal nos arquivos virtuais; máximo 40 resultados.", { query: string }, ["query"]],
  ["get_context", "Retorna somente contexto confirmado do projeto.", {}, []],
  ["assets", "Lista metadados dos assets selecionados; nunca segredos.", {}, []],
  ["checkpoint", "Salva checkpoint temporário nomeado do workspace.", { name: string }, ["name"]],
  ["restore", "Restaura checkpoint temporário; initial preserva o estado inicial.", { name: string }, ["name"]],
  ["run_validation", "Valida estaticamente o workspace. Build e visual acontecem isolados após a edição.", {}, []],
];

const ALL_WEBSITE_TOOLS = definitions.map(([name, description, properties, required]) => ({ type: "function" as const, function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } }));

export const WEBSITE_TOOLS = ALL_WEBSITE_TOOLS.filter((tool) => !["read_design_reference", "record_design_direction"].includes(tool.function.name));

function text(args: Record<string, unknown>, key: string, empty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!empty && !value.length)) throw new Error(`Argumento inválido: ${key}`);
  return value;
}

export class WebsiteTools {
  private workspace: WebsiteFiles;
  private checkpoints = new Map<string, WebsiteFiles>();
  private direction: WebsiteDesignDirection | undefined;

  constructor(files: WebsiteFiles, private readonly data: { context: object; assets: WebsiteAsset[]; impeccable?: boolean; requireDesignDirection?: boolean; designDirection?: WebsiteDesignDirection }) {
    validateFiles(files);
    this.direction = data.designDirection ? parseWebsiteDesignDirection(data.designDirection) : undefined;
    this.workspace = { ...files };
    this.checkpoints.set("initial", { ...files });
  }

  get files(): WebsiteFiles { return { ...this.workspace }; }
  get designDirection(): WebsiteDesignDirection | undefined { return this.direction ? { ...this.direction } : undefined; }
  get definitions(): typeof WEBSITE_TOOLS { return this.data.impeccable ? ALL_WEBSITE_TOOLS : WEBSITE_TOOLS; }

  async execute(name: string, input: unknown): Promise<unknown> {
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
            const newText = text(args, "new", true);
            if (current.includes(old) && current.indexOf(old) === current.lastIndexOf(old)) {
              next[path] = current.replace(old, () => newText);
            } else {
              const normCurrent = current.replace(/\r\n/g, "\n");
              const normOld = old.replace(/\r\n/g, "\n");
              if (normCurrent.includes(normOld) && normCurrent.indexOf(normOld) === normCurrent.lastIndexOf(normOld)) {
                next[path] = normCurrent.replace(normOld, () => newText.replace(/\r\n/g, "\n"));
              } else {
                throw new Error("Trecho ausente ou ambíguo.");
              }
            }
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
