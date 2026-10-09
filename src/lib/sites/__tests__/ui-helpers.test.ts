import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantText,
  completionNotice,
  editableFile,
  formatRelative,
  isModelSelectionLocked,
  isOverrideSkill,
  isPublishableBuild,
  isSelectableSkill,
  isUuid,
  matchesModelFilters,
  modelModeLabel,
  modelPriceLabel,
  parseSystemEvent,
  projectStatusLabel,
  runStatusLabel,
  safeSiteUrl,
  tokenUsage,
  usageBreakdown,
  usageLabels,
} from "../ui-helpers";
import type { WebsiteBuild, WebsiteDeployment, WebsiteSkill } from "../types";
import { clearSiteDrafts, deploymentResponse, getSiteDraft, reconcileDeploymentKeys, setSiteDraft, siteDraftScope, stagedFileProblem, uploadStagedFiles, type DeploymentAttempt, type StagedUpload } from "../ui";

describe("ui-helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("rotula os estados conforme o contrato visual", () => {
    expect(runStatusLabel("queued")).toBe("Na fila...");
    expect(runStatusLabel("planning")).toBe("Pensando...");
    expect(runStatusLabel("editing")).toBe("Criando e editando arquivos...");
    expect(runStatusLabel("validating")).toBe("Validando o site...");
    expect(runStatusLabel("completed")).toBe("Concluída");
    expect(runStatusLabel("failed")).toBe("Falhou");
    expect(runStatusLabel("cancelled")).toBe("Cancelada");
    expect(projectStatusLabel("draft")).toBe("Rascunho");
    expect(projectStatusLabel("published")).toBe("Publicado");
    expect(projectStatusLabel("archived")).toBe("Arquivado");
    expect(modelModeLabel("auto")).toBe("Automático");
    expect(modelModeLabel("manual")).toBe("Manual");
  });

  it("formata datas passadas, futuras e inválidas em português", () => {
    expect(formatRelative(null)).toBe("Data indisponível");
    expect(formatRelative("inválido")).toBe("Data indisponível");
    expect(formatRelative(new Date().toISOString())).toBe("agora mesmo");
    expect(formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("há 5 minutos");
    expect(formatRelative(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("há 3 horas");
    expect(formatRelative(new Date(Date.now() - 86_400_000).toISOString())).toBe("há 1 dia");
    expect(formatRelative(new Date(Date.now() + 86_400_000).toISOString())).toBe("em 1 dia");
    expect(formatRelative(new Date(Date.now() - 40 * 86_400_000).toISOString())).toBe("há 1 mês");
  });

  it("resume os eventos reais sem exibir instruções, logs ou erros técnicos", () => {
    expect(parseSystemEvent(JSON.stringify({ checkpoint: "initial", revision_id: "rev-1", files: ["src/App.tsx"] }))).toBe("Ponto de restauração salvo.");
    expect(parseSystemEvent(JSON.stringify({ active_skills: ["Anti-AI", "Design Profissional"] }))).toBe("Skills ativas: Anti-AI · Design Profissional");
    expect(parseSystemEvent(JSON.stringify({ vision_assets: ["a", "b"] }))).toBe("2 imagem(ns) preparada(s) para análise.");
    expect(parseSystemEvent(JSON.stringify({ validation: { success: true, qa: { passed: true } } }))).toBe("Validação técnica concluída com sucesso.");
    expect(parseSystemEvent(JSON.stringify({ validation: { success: true, qa: { passed: false } } }))).toBe("A validação identificou ajustes necessários.");
    expect(parseSystemEvent(JSON.stringify({ usage: { totalTokens: 15 } }))).toBe("Uso do modelo registrado.");
    expect(parseSystemEvent(JSON.stringify({ role: "tool", content: JSON.stringify({ saved: "src/App.tsx" }) }))).toBe("Arquivo atualizado: src/App.tsx");
    expect(parseSystemEvent(JSON.stringify({ role: "tool", content: JSON.stringify({ error: "stacktrace privado" }) }))).not.toContain("stacktrace");
    for (const value of ["REGRAS IMUTÁVEIS DO SITE STUDIO", "{JSON incompleto", "[\"segredo\"]", "null"]) {
      expect(parseSystemEvent(value)).toBe("Atividade interna do agente registrada.");
    }
    expect(parseSystemEvent("Execução cancelada.")).toBe("Execução cancelada.");
    expect(parseSystemEvent("READY — AWAITING CREDENTIALS")).toContain("Integração não configurada");
  });

  it.each([
    ["started", "consulta iniciada; aguardando resposta"],
    ["completed", "resposta recebida"],
    ["failed", "falha na consulta"],
  ])("mostra modelo e estado da consulta %s sem expor o pedido", (status, label) => {
    expect(parseSystemEvent(JSON.stringify({
      model_call: { model: "gateway:provider/model", status }, prompt: "pedido privado", arguments: "segredo",
    }))).toBe(`Modelo gateway:provider/model: ${label}.`);
  });

  it.each([
    ["list", "Listando arquivos", "Arquivos listados"],
    ["read", "Lendo arquivo", "Leitura de arquivo concluída"],
    ["read_files", "Lendo arquivos", "Leitura de arquivos concluída"],
    ["create", "Criando arquivo", "Arquivo criado"],
    ["write", "Atualizando arquivo", "Arquivo atualizado"],
    ["patch", "Editando arquivo", "Arquivo editado"],
    ["delete", "Excluindo arquivo", "Arquivo excluído"],
    ["rename", "Renomeando arquivo", "Arquivo renomeado"],
    ["search", "Buscando nos arquivos", "Busca nos arquivos concluída"],
    ["get_context", "Consultando informações confirmadas", "Informações confirmadas consultadas"],
    ["assets", "Consultando imagens e anexos", "Imagens e anexos consultados"],
    ["checkpoint", "Salvando ponto de restauração", "Ponto de restauração salvo"],
    ["restore", "Recuperando ponto de restauração", "Ponto de restauração recuperado"],
    ["run_validation", "Verificando estrutura e conteúdo", "Verificação estática concluída"],
  ])("traduz início e término da ferramenta %s", (tool, started, completed) => {
    expect(parseSystemEvent(JSON.stringify({ tool, status: "started", path: "src/App.tsx", arguments: { content: "fonte privada" } }))).toBe(`${started}: src/App.tsx...`);
    expect(parseSystemEvent(JSON.stringify({ tool, result: JSON.stringify({ saved: "src/App.tsx", content: "fonte privada" }) }))).toBe(`${completed}: src/App.tsx.`);
    expect(parseSystemEvent(JSON.stringify({ tool, result: {} }))).toBe(`${completed}.`);
  });

  it("resume resultados serializados e objetos, falhas e verificação estática", () => {
    expect(parseSystemEvent(JSON.stringify({ tool: "write", result: { saved: "public/style.css" } }))).toBe("Arquivo atualizado: public/style.css.");
    expect(parseSystemEvent(JSON.stringify({ tool: "read", result: '{"read":128}' }))).toBe("Leitura de arquivo concluída.");
    expect(parseSystemEvent(JSON.stringify({ tool: "patch", result: '{"error":"segredo"}' }))).toBe("Não foi possível concluir uma operação do agente.");
    expect(parseSystemEvent(JSON.stringify({ tool: "run_validation", result: { passed: true } }))).toBe("Verificação estática aprovada; renderização ainda não verificada.");
    expect(parseSystemEvent(JSON.stringify({ tool: "run_validation", result: '{"passed":false,"errors":["fonte privada"]}' }))).toBe("Verificação estática requer ajustes.");
  });

  it("não confunde validação técnica com renderização nem aprova integração ausente", () => {
    expect(parseSystemEvent(JSON.stringify({ validation: { status: "started" } }))).toBe("Verificando o site...");
    expect(parseSystemEvent(JSON.stringify({ validation: { status: "unconfigured", success: true, qa: { passed: true }, logs: "E2B_API_KEY=segredo" } }))).toBe("Ambiente E2B não configurado. Renderização não verificada; site permanece como rascunho.");
    expect(parseSystemEvent(JSON.stringify({ validation: { status: "ready", success: true, errorCount: 0, warningCount: 2, qa: { passed: true } } }))).toBe("Validação técnica concluída com sucesso (0 erro(s), 2 aviso(s)).");
    expect(parseSystemEvent(JSON.stringify({ validation: { status: "failed", success: true, qa: { passed: true } } }))).toBe("A validação identificou ajustes necessários.");
    expect(parseSystemEvent(JSON.stringify({ validation: {} }))).toBe("Validação do site registrada.");
  });

  it("oculta caminhos, modelos e ferramentas inesperados sem ecoar dados privados", () => {
    for (const path of ["src/../../.env", "src//App.tsx", "src/.env", "src/App.tsx?token=segredo", "src/App.tsx\nsegredo", "src/" + "a".repeat(181)]) {
      expect(parseSystemEvent(JSON.stringify({ tool: "read", status: "started", path }))).toBe("Lendo arquivo...");
      expect(parseSystemEvent(JSON.stringify({ saved: path }))).toBe("Atividade interna do agente registrada.");
    }
    expect(parseSystemEvent(JSON.stringify({ tool: "segredo", status: "started", arguments: "pedido privado" }))).toBe("Executando operação do agente...");
    expect(parseSystemEvent(JSON.stringify({ tool: "segredo", result: "conteúdo privado" }))).toBe("Atividade interna do agente registrada.");
    expect(parseSystemEvent(JSON.stringify({ model_call: { model: "modelo\nsegredo", status: "started" } }))).toBe("Modelo: consulta iniciada; aguardando resposta.");
    expect(parseSystemEvent(JSON.stringify({ model_call: { model: "provider/model", status: "pedido privado" } }))).toBe("Atividade interna do agente registrada.");
  });

  it("extrai apenas texto visível de envelopes do assistente", () => {
    expect(assistantText("Título atualizado.")).toBe("Título atualizado.");
    expect(assistantText(JSON.stringify({ role: "assistant", content: "Atualizado.", tool_calls: ["interno"] }))).toBe("Atualizado.");
    expect(assistantText(JSON.stringify({ role: "assistant", content: null, tool_calls: ["interno"] }))).toBe("Preparando alterações nos arquivos...");
    expect(assistantText(JSON.stringify({ passed: true, summary: "Visual aprovado." }))).toBe("Visual aprovado.");
    expect(assistantText("{\"role\":\"assistant\"")).not.toContain("role");
  });

  it("aceita apenas URLs HTTPS sem credenciais", () => {
    expect(safeSiteUrl("https://example.com/site")).toBe("https://example.com/site");
    for (const value of [null, undefined, "", "javascript:alert(1)", "data:text/html,test", "http://example.com", "https://user:password@example.com", "/relative"]) {
      expect(safeSiteUrl(value)).toBeNull();
    }
  });

  it("preserva arquivos fixos e mede o limite de edição em bytes", () => {
    for (const path of ["package.json", "/package.json", "tsconfig.json", "vite.config.ts", "public/foto.png"]) expect(editableFile(path, "x")).toBe(false);
    expect(editableFile("src/App.tsx", "x".repeat(100 * 1024))).toBe(true);
    expect(editableFile("src/App.tsx", "x".repeat(100 * 1024 + 1))).toBe(false);
    expect(editableFile("src/App.tsx", "á".repeat(51 * 1024))).toBe(false);
  });

  it("filtra modelos pelas capacidades informadas sem presumir visão", () => {
    const text = { id: "text", name: "Texto", supportsTools: true };
    const vision = { id: "vision", name: "Visão", supportsTools: false, inputModalities: ["image", "text"] };
    const both = { ...vision, supportsTools: true };
    expect(matchesModelFilters(text, false, false)).toBe(true);
    expect(matchesModelFilters(text, true, false)).toBe(true);
    expect(matchesModelFilters(text, false, true)).toBe(false);
    expect(matchesModelFilters(vision, true, false)).toBe(false);
    expect(matchesModelFilters(vision, false, true)).toBe(true);
    expect(matchesModelFilters(vision, true, true)).toBe(false);
    expect(matchesModelFilters(both, true, true)).toBe(true);
  });

  it("contabiliza somente uso numérico válido", () => {
    expect(tokenUsage(JSON.stringify({ usage: { totalTokens: 150 } }))).toBe(150);
    for (const content of ["texto", "null", "{}", '{"usage":{"totalTokens":-1}}', '{"usage":{"totalTokens":"150"}}']) expect(tokenUsage(content)).toBe(0);
  });

  const build = (patch: Partial<WebsiteBuild> = {}): Pick<WebsiteBuild, "success" | "status" | "qa" | "screenshots"> => ({
    success: true, status: "ready",
    qa: { passed: true, errors: [], warnings: [], visual_review: "Aprovado com evidência real." },
    screenshots: { desktop: "data:image/png;base64,iVBORw0KGgo", mobile: "data:image/png;base64,iVBORw0KGgo" },
    ...patch,
  });

  it("só considera publicável build pronto com QA, crítica visual e screenshots reais", () => {
    expect(isPublishableBuild(build())).toBe(true);
    expect(isPublishableBuild(build({ success: false }))).toBe(false);
    expect(isPublishableBuild(build({ status: "failed" }))).toBe(false);
    expect(isPublishableBuild(build({ status: "unconfigured" }))).toBe(false);
    expect(isPublishableBuild(build({ qa: { passed: false, errors: [], warnings: [], visual_review: "Aprovado." } }))).toBe(false);
    expect(isPublishableBuild(build({ qa: { passed: true, errors: [], warnings: [] } }))).toBe(false);
    expect(isPublishableBuild(build({ qa: { passed: true, errors: [], warnings: [], visual_review: "   " } }))).toBe(false);
    expect(isPublishableBuild(build({ screenshots: { desktop: "data:image/png;base64,AAAA", mobile: "data:image/png;base64,iVBORw0KGgo" } }))).toBe(false);
    expect(isPublishableBuild(build({ screenshots: { desktop: "data:image/png;base64,iVBORw0KGgo" } }))).toBe(false);
  });

  it("calcula preço por milhão de tokens somente a partir de campos finitos", () => {
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true, pricing: { prompt: "0.0000015", completion: "0.000006" } })).toBe("Entrada US$ 1,50 / M tokens · Saída US$ 6,00 / M tokens");
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true, pricing: { prompt: "0", completion: "0" } })).toBe("Entrada grátis / M tokens · Saída grátis / M tokens");
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true, pricing: { prompt: "0.0000000001", completion: "0.0000000001" } })).toContain("< US$ 0,01");
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true })).toBeNull();
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true, pricing: { prompt: "grátis", completion: "0" } })).toBeNull();
    expect(modelPriceLabel({ id: "m", name: "M", supportsTools: true, pricing: { prompt: "-1", completion: "0" } })).toBeNull();
  });

  it("encerra apenas a tentativa terminal confirmada, inclusive no polling", () => {
    const keys = new Map<string, DeploymentAttempt>([["build", { key: "attempt", deploymentId: "deployment" }]]);
    reconcileDeploymentKeys(keys, [{ id: "old", status: "published" }]);
    reconcileDeploymentKeys(keys, [{ id: "deployment", status: "deploying" }]);
    expect(keys.get("build")?.key).toBe("attempt");
    reconcileDeploymentKeys(keys, [{ id: "deployment", status: "failed" }]);
    expect(keys.size).toBe(0);
    keys.set("build", { key: "retry", deploymentId: "retry-deployment" });
    reconcileDeploymentKeys(keys, [{ id: "deployment", status: "failed" }]);
    expect(keys.get("build")?.key).toBe("retry");
    reconcileDeploymentKeys(keys, [{ id: "retry-deployment", status: "published" }]);
    expect(keys.size).toBe(0);
  });

  it("preserva chave ambígua e libera rollback somente após terminal identificado", () => {
    const keys = new Map<string, DeploymentAttempt>([["rollback", { key: "same-key" }]]);
    reconcileDeploymentKeys(keys, [{ id: "old", status: "published" }]);
    expect(keys.size).toBe(1);
    keys.get("rollback")!.deploymentId = "new";
    reconcileDeploymentKeys(keys, [{ id: "new", status: "failed" }]);
    expect(keys.size).toBe(0);
  });

  it("lê confirmação terminal mesmo no HTTP 409 e não confunde conflito com término", async () => {
    const deployment = { id: "deployment", status: "failed" } as WebsiteDeployment;
    await expect(deploymentResponse(new Response(JSON.stringify({ deployment }), { status: 409 }))).resolves.toEqual(deployment);
    await expect(deploymentResponse(new Response(JSON.stringify({ error: "conflito" }), { status: 409 }))).rejects.toThrow();
    await expect(deploymentResponse(new Response("invalid", { status: 502 }))).rejects.toThrow();
  });

  it("remove cada upload confirmado antes do seguinte e retenta somente os válidos restantes", async () => {
    const file = new File(["image"], "foto.png", { type: "image/png" });
    let staged: StagedUpload[] = [
      { id: "ok", file, url: "blob:ok" },
      { id: "retry", file, url: "blob:retry" },
      { id: "invalid", file, url: "blob:invalid", problem: "inválido" },
    ];
    const sent: string[] = [];
    const upload = vi.fn(async (item: StagedUpload) => {
      sent.push(item.id);
      if (item.id === "retry" && sent.length === 2) {
        expect(staged.map((entry) => entry.id)).toEqual(["retry", "invalid"]);
        throw new Error("failure");
      }
      return item.id;
    });
    const success = (item: StagedUpload) => { staged = staged.filter((entry) => entry.id !== item.id); };
    const failure = (item: StagedUpload) => { staged = staged.map((entry) => entry.id === item.id ? { ...entry, uploadError: "tente novamente" } : entry); };
    await uploadStagedFiles(staged, upload, success, failure);
    expect(staged.map((item) => item.id)).toEqual(["retry", "invalid"]);
    await uploadStagedFiles(staged, upload, success, failure);
    expect(sent).toEqual(["ok", "retry", "retry"]);
    expect(staged.map((item) => item.id)).toEqual(["invalid"]);
  });

  it("não reenvia upload ambíguo nem arquivos inválidos", async () => {
    const file = new File(["image"], "foto.png", { type: "image/png" });
    expect(stagedFileProblem(file)).toBeUndefined();
    expect(stagedFileProblem(new File([], "vazia.png", { type: "image/png" }))).toBeTruthy();
    expect(stagedFileProblem(new File(["x"], "foto.svg", { type: "image/svg+xml" }))).toBeTruthy();
    const upload = vi.fn();
    await uploadStagedFiles([{ id: "unknown", file, url: "blob:x", uncertain: true }], upload, vi.fn(), vi.fn());
    expect(upload).not.toHaveBeenCalled();
  });

  it("preserva rascunhos só em memória com identidade confirmada, isolando tenant, ator e projeto", () => {
    clearSiteDrafts();
    const identity = { authenticated: true, clientId: "tenant-a", actorId: "actor-a" };
    const scope = siteDraftScope(identity, "project-a");
    expect(siteDraftScope(null, "project-a")).toBeNull();
    expect(siteDraftScope({ ...identity, authenticated: false }, "project-a")).toBeNull();
    expect(siteDraftScope({ ...identity, clientId: null }, "project-a")).toBeNull();
    setSiteDraft(scope, "files", { files: { "src/App.tsx": "rascunho" }, revisionId: "old" });
    expect(getSiteDraft(scope, "files")).toEqual({ files: { "src/App.tsx": "rascunho" }, revisionId: "old" });
    for (const other of [siteDraftScope({ ...identity, clientId: "tenant-b" }, "project-a"), siteDraftScope({ ...identity, actorId: "actor-b" }, "project-a"), siteDraftScope(identity, "project-b"), null]) {
      expect(getSiteDraft(other, "files")).toBeNull();
    }
    setSiteDraft(scope, "files", null);
    expect(getSiteDraft(scope, "files")).toBeNull();
    setSiteDraft(scope, "chat", { prompt: "pedido", selected: ["asset"] });
    clearSiteDrafts();
    expect(getSiteDraft(scope, "chat")).toBeNull();
  });

  const skill = (patch: Partial<WebsiteSkill> = {}): WebsiteSkill => ({
    id: "11111111-1111-4111-8111-111111111111", client_id: "22222222-2222-4222-8222-222222222222",
    name: "Skill", slug: "skill", description: "", instructions: "x", category: "custom", tags: [],
    priority: 50, trigger_mode: "manual", is_enabled: true, is_builtin: false, version: 1, ...patch,
  });

  it("identifica override de builtin e skills selecionáveis por projeto", () => {
    expect(isOverrideSkill(skill())).toBe(false);
    expect(isOverrideSkill(skill({ is_builtin: true, client_id: null }))).toBe(false);
    expect(isOverrideSkill(skill({ is_builtin: true }))).toBe(true);
    expect(isSelectableSkill(skill())).toBe(true);
    expect(isSelectableSkill(skill({ is_enabled: false }))).toBe(false);
    expect(isSelectableSkill(skill({ trigger_mode: "automatic" }))).toBe(false);
    expect(isSelectableSkill(skill({ is_builtin: true }))).toBe(false);
    expect(isSelectableSkill(skill({ id: "builtin:frontend-design" }))).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("builtin:frontend-design")).toBe(false);
  });

  it("trava o seletor de modelos durante execução ativa, envio ou arquivamento", () => {
    expect(isModelSelectionLocked({ activeRun: true, sending: false, updating: false, archived: false })).toBe(true);
    expect(isModelSelectionLocked({ activeRun: false, sending: true, updating: false, archived: false })).toBe(true);
    expect(isModelSelectionLocked({ activeRun: false, sending: false, updating: true, archived: false })).toBe(true);
    expect(isModelSelectionLocked({ activeRun: false, sending: false, updating: false, archived: true })).toBe(true);
    expect(isModelSelectionLocked({ activeRun: false, sending: false, updating: false, archived: false })).toBe(false);
  });

  it("distingue rascunho sem validação, validação reprovada e revisão aprovada na notificação de conclusão", () => {
    expect(completionNotice("build", null)).toEqual({
      type: "success",
      message: "Validação concluída.",
    });

    const unconfigured = {
      status: "unconfigured" as const,
      success: true,
      qa: { passed: true, errors: [], warnings: [] },
      screenshots: {},
    };
    expect(completionNotice("agent", unconfigured)).toEqual({
      type: "info",
      message: "Alterações concluídas. Ambiente de validação não configurado; rascunho salvo sem verificação de renderização.",
    });

    const failed = {
      status: "failed" as const,
      success: false,
      qa: { passed: false, errors: ["Erro de compilação"], warnings: [] },
      screenshots: {},
    };
    expect(completionNotice("agent", failed)).toEqual({
      type: "warning",
      message: "Execução concluída, mas a validação técnica identificou ajustes necessários. Verifique a lista de validações.",
    });

    const approved = {
      status: "ready" as const,
      success: true,
      qa: { passed: true, errors: [], warnings: [], visual_review: "Aprovado com evidência" },
      screenshots: {
        desktop: "data:image/png;base64,iVBORw0KGgo",
        mobile: "data:image/png;base64,iVBORw0KGgo",
      },
    };
    expect(completionNotice("agent", approved)).toEqual({
      type: "success",
      message: "Alterações concluídas e validadas! Visualização atualizada.",
    });

    expect(completionNotice("agent", null)).toEqual({
      type: "success",
      message: "Alterações concluídas! Visualização atualizada.",
    });
  });

  it("extrai métricas detalhadas de telemetria sem inventar custo zero", () => {
    const rawEvents = [
      JSON.stringify({
        usage: {
          promptTokens: 1200,
          completionTokens: 350,
          cachedTokens: 400,
          totalTokens: 1550,
          estimated: false,
        },
      }),
      JSON.stringify({
        usage: {
          inputTokens: 300,
          outputTokens: 100,
          totalTokens: 400,
          estimated: true,
          costUsd: 0.0025,
        },
      }),
    ];

    const breakdown = usageBreakdown(rawEvents);
    expect(breakdown.totalTokens).toBe(1950);
    expect(breakdown.inputTokens).toBe(1500);
    expect(breakdown.outputTokens).toBe(450);
    expect(breakdown.cachedTokens).toBe(400);
    expect(breakdown.isEstimated).toBe(true);
    expect(breakdown.costUsd).toBe(0.0025);

    const labels = usageLabels(breakdown);
    expect(labels.tokensText).toBe("1.950 tokens (1.500 entrada · 450 saída · 400 cache)");
    expect(labels.estimatedBadge).toBe("Estimado");
    expect(labels.costText).toBe("Custo registrado: US$ 0,0025");

    const noCostBreakdown = usageBreakdown([JSON.stringify({ usage: { totalTokens: 500 } })]);
    const noCostLabels = usageLabels(noCostBreakdown);
    expect(noCostLabels.costText).toBe("Custo: não informado pelo provedor");
  });
});

it("reports disabled skills without claiming Impeccable applied", () => {
  expect(parseSystemEvent(JSON.stringify({ active_skills: [] }))).toBe("Nenhuma skill ativa nesta execução.");
});
