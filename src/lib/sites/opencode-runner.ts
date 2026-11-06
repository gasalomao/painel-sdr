import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  detectImpeccableAntiPatterns,
  sanitizeHtmlForImpeccable,
  validateHtmlCss,
  type ImpeccableDetectResult,
} from "./impeccable-detector";

export interface OpenCodeRunOptions {
  workspaceDir: string;
  leadName?: string;
  niche?: string;
  additionalPrompt?: string;
  model?: string;
  timeoutMs?: number;
  /** "build" gera o site do zero; "repair" corrige um index.html existente em modo cirúrgico. */
  mode?: "build" | "repair";
  onLog?: (line: string) => void;
}

export interface OpenCodeRunResult {
  success: boolean;
  generatedFiles: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
  skillActivated?: boolean;
  error?: string;
  detectorReport?: ImpeccableDetectResult;
}

/**
 * Constrói o prompt especializado para o OpenCode CLI utilizar com as Skills Impeccable, Anti-AI, Frontend-Design e Conversion-Copy.
 */
export function buildAutonomousSitePrompt(opts: {
  leadName?: string;
  niche?: string;
  additionalPrompt?: string;
}): string {
  const { leadName = "Empresa", niche = "Serviços Locais", additionalPrompt } = opts;

  return [
    `/impeccable "Landing page autoral em index.html para ${leadName} (Nicho: ${niche})"`,
    ``,
    `# DIRETIVA DE EXECUÇÃO DE FRONTEND — MODO HEADLESS AUTÔNOMO`,
    ``,
    `1. AÇÃO IMEDIATA:`,
    `- Crie diretamente o arquivo 'index.html' no diretório atual utilizando a ferramenta write.`,
    `- NÃO perca tempo lendo documentações externas ou chamando skills interativas adicionais: todas as regras do Impeccable Craft Floor, Anti-AI Design, Conversion-Copy e tokens de design já estão sintetizados abaixo e nos arquivos DESIGN.md, PRODUCT.md e INFORMACOES-DO-NEGOCIO.txt já anexados.`,
    `- PROIBIÇÃO HEADLESS: É terminantemente PROIBIDO executar comandos interativos como 'serve-question --wait' ou qualquer script que espere por interação humana. Você opera em pipeline autônomo headless.`,
    `- GRAVE DIRETO NO DESTINO FINAL: construa o 'index.html' no próprio arquivo, em blocos sucessivos (write do primeiro bloco e depois append/edição dos próximos). NUNCA monte partes em arquivos auxiliares (_p1.html, chunk.css, etc.) para concatenar no fim — se o tempo acabar, o site fica inexistente.`,
    ``,
    `2. ARQUITETURA DO PROJETO & BENCHMARK INEGOCIÁVEL (${leadName} - ${niche}):`,
    `- Gere um arquivo 'index.html' autoral, rico e completo (tamanho alvo: 80 KB a 120 KB, mais de 1.800 linhas de código sólido e autossuficiente).`,
    `- ESTRUTURA MANDATÓRIA DE 10 SEÇÕES COMPLETAS:`,
    `  1. Top Utility Bar & Navigation Header (contato rápido, status operacional e navegação suave).`,
    `  2. Hero Section de Alto Impacto (headline editorial magnética, prova social autêntica e CTA principal).`,
    `  3. Banner de Estatísticas e Métricas Reais (avaliador Google Maps, nota oficial e total de reviews reais catalogadas).`,
    `  4. O Espaço / Ambiente Físico (composição visual rica com fotos reais de ./fotos/).`,
    `  5. Especialidades & Serviços Detalhados (cards ou ledger editorial com descrições técnicas e benefícios).`,
    `  6. Destaque de Assinatura / Procedimento Principal (experiência principal do negócio em destaque).`,
    `  7. Galeria / Portfólio de Resultados Reais (grid ou mosaico moderno com fotos autênticas de ./fotos/).`,
    `  8. Depoimentos e Avaliações Reais de Clientes (comentários verificados do Google Maps).`,
    `  9. Localização, Horários e Mapa Tático (endereço real, horários de atendimento e rota).`,
    `  10. CTA Final de Fechamento & Rodapé Completo (links diretos para WhatsApp e copyright).`,
    ``,
    `3. REGRAS ABSOLUTAS DO CRAFT FLOOR & MODO PERSUADE (ZERO ANTI-PATTERNS NO DETECTOR):`,
    `- ZERO [dark-glow]: É estritamente PROIBIDO usar box-shadow ou text-shadow com glow/halo colorido (#dca64e, #f59e0b, ou qualquer cor saturada/dourada) em fundos escuros. Use exclusivamente sombras de elevação neutras (ex: box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)) e bordas hairline de 1px.`,
    `- ZERO [kicker-above-heading]: NUNCA insira nenhuma etiqueta, badge, span, div ou p isolado posicionado imediatamente antes ou acima de tags de cabeçalho (h1 a h6). Se houver códigos, números ou categorias, insira-os DENTRO do título ou DEPOIS do título como badge.`,
    `- ZERO [pulsing-dot]: NUNCA adicione bolinhas pulsantes com animações infinitas para simular status online. Use indicadores visuais estáticos e honestos.`,
    `- ZERO [overused-font]: É estritamente PROIBIDO usar Plus Jakarta Sans, Inter, Roboto, Fraunces, Geist ou Space Grotesk. Use exclusivamente 'DM Sans' para textos de interface e 'Syne' ou 'Outfit' para títulos display.`,
    `- ZERO [low-contrast]: Todo texto DEVE cumprir a norma WCAG AA (contraste mínimo de 4.5:1). Em temas escuros use #f1f5f9, #e2e8f0 ou #94a3b8 para textos secundários; nunca use cinzas escuros invisíveis como #6b7689 ou #686873.`,
    `- ZERO [tiny-text]: Nenhum texto de corpo, legenda ou metadado pode ter menos de 12px (mínimo: 0.75rem / 12px; ideal: 0.8125rem / 13px).`,
    `- ZERO [side-tab]: Nunca use borda lateral grossa (border-left: 4px) em cards com cantos arredondados.`,
    `- ZERO [nested-cards]: Mantenha a hierarquia plana. Nunca aninhe um card dentro de outro card.`,
    `- ZERO [cramped-padding]: Todo container com borda ou fundo (incluindo top bar e seções) deve ter padding interno generoso (no mínimo 16px a 24px) para que o texto nunca encoste nas bordas.`,
    `- ZERO [skipped-heading]: Respeite rigorosamente a ordem hierárquica dos cabeçalhos sem pular níveis (h1 -> h2 -> h3).`,
    `- ZERO [cream-palette]: Nunca use fundos bege/creme genéricos de IA (#fbf9f4). Use fundos intencionais (branco puro #ffffff ou tons escuros nobres).`,
    ``,
    `4. ACERVO DE FOTOS REAIS EM ./fotos/:`,
    `- Inspecione o acervo em ./fotos/ e distribua fotos reais diferentes em cada seção (Hero, Espaço, Serviços e Galeria). Não repita a mesma foto.`,
    `- Integre os dados reais de INFORMACOES-DO-NEGOCIO.txt (endereço, telefone, WhatsApp e avaliações) sem inventar dados falsos.`,
    ``,
    `5. MOVIMENTO OBRIGATÓRIO (REPROVADO AUTOMATICAMENTE SE AUSENTE):`,
    `- No mínimo 2 blocos @keyframes nomeados e realmente usados por elementos da página.`,
    `- Revelação por scroll com new IntersectionObserver(...) aplicando a classe .is-visible em elementos [data-reveal] (opacity 0 -> 1, translateY(24px) -> 0).`,
    `- Curva de movimento obrigatória: cubic-bezier(0.16, 1, 0.3, 1) nas transições de entrada.`,
    `- Obrigatório @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }.`,
    `- Proibido pulso infinito em bolinhas de status.`,
    ``,
    `6. CONTRATO DE LAYOUT (MEDIDO EM 1440x900 E 375x812):`,
    `- Reset universal EXATAMENTE assim: *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; } — NUNCA coloque padding diferente de 0 no reset.`,
    `- Padding generoso apenas em containers, seções e cards (nunca em p, h1, span ou li soltos).`,
    `- html, body { overflow-x: hidden; width: 100%; } e img { max-width: 100%; height: auto; }.`,
    `- Botões com padding vertical entre 0.75rem e 1.25rem; nenhum controle pode ficar gigante.`,
    `- Zero overflow horizontal em 375px.`,
    ``,
    additionalPrompt ? `\nORIENTAÇÃO ESPECÍFICA:\n${additionalPrompt}` : "",
  ].join("\n");
}

/**
 * AGENTS.md temporário do modo reparo. O OpenCode lê o AGENTS.md do diretório
 * automaticamente: sem esta troca, o agente reativa o fluxo de design da
 * Impeccable (modelagem de produto) e nunca chega a editar o index.html.
 */
const REPAIR_AGENTS_MD = `# MODO REPARO

Você está reparando um \`index.html\` EXISTENTE.

- Edite APENAS \`index.html\`. Nada mais.
- NÃO rode a skill \`/impeccable\`, NÃO gere PRODUCT.md, NÃO redesenhe a página.
- Não crie arquivos novos, não leia fotos, não refaça o briefing.
- Mantenha o movimento existente: \`@keyframes\`, \`IntersectionObserver\`,
  \`cubic-bezier(0.16, 1, 0.3, 1)\` e \`prefers-reduced-motion\`.
- Valide com o detector oficial antes de finalizar:
  \`.opencode/skills/impeccable/scripts/bin/windows-x64/impeccable.exe detect index.html\`
  (Linux: \`.opencode/skills/impeccable/scripts/bin/linux-x64/impeccable detect index.html\`).
`;

/**
 * Prompt do modo "repair": correção cirúrgica de um index.html já existente.
 * Não redesenha, não cria arquivos novos, não roda o fluxo de design.
 */
export function buildRepairPrompt(opts: {
  leadName?: string;
  violationsSummary: string;
}): string {
  const { leadName = "Empresa", violationsSummary } = opts;

  return [
    "Você está em MODO REPARO sobre um `index.html` já existente e pronto.",
    "Sua ÚNICA tarefa é eliminar os anti-patterns listados abaixo, em-place.",
    "",
    "## REGRAS DO MODO REPARO",
    "- Edite APENAS `index.html`. Não crie, renomeie ou apague nenhum outro arquivo.",
    "- Não redesenhe, não reescreva a página, não troque a paleta, tipografia, fotos ou estrutura.",
    "- Mudanças mínimas: CSS e atributos Surgical (padding, font-size, animation, aria).",
    "- Não rode a skill `/impeccable` de design, não gere PRODUCT.md, não refaça o briefing.",
    "- Não leia nem anexe fotos; as imagens já estão referenciadas no HTML.",
    "- Não remova seções, conteúdo, links de WhatsApp, animações de scroll ou `@keyframes`.",
    "- Mantenha o movimento obrigatório: `@keyframes`, revelação por `IntersectionObserver`,",
    "  `cubic-bezier(0.16, 1, 0.3, 1)` e `prefers-reduced-motion`.",
    "",
    "## ANTI-PATTERNS A CORRIGIR",
    violationsSummary,
    "",
    "## COMO VERIFICAR (obrigatório antes de terminar)",
    "Rode o detector oficial e confirme que o contador de anti-patterns zerou:",
    "  .opencode/skills/impeccable/scripts/bin/windows-x64/impeccable.exe detect index.html",
    "(em Linux: .opencode/skills/impeccable/scripts/bin/linux-x64/impeccable detect index.html)",
    "Se ainda houver achados, corrija e rode o detector de novo. Só finalize com 0 anti-patterns.",
    "",
    "## EMPRESA",
    leadName,
  ].join("\n");
}

/**
 * Executa o OpenCode CLI na VPS em modo headless (--standalone --auto).
 */
export async function runOpenCodeHeadless(
  opts: OpenCodeRunOptions
): Promise<OpenCodeRunResult> {
  const {
    workspaceDir,
    leadName,
    niche,
    additionalPrompt,
    mode = "build",
    model =
      mode === "repair"
        ? process.env.SITE_REPAIR_MODEL || "9router/cx/gpt-5.6-terra"
        : process.env.OPENCODE_MODEL || "9router/combo-principal",
    timeoutMs = mode === "repair" ? 600_000 : 660_000,
    onLog,
  } = opts;

  const startTime = Date.now();
  const indexHtmlPath = path.join(workspaceDir, "index.html");

  // No modo repair o AGENTS.md do workspace é trocado por um modo-reparo e
  // restaurado no fim — é ele que manda o agente refazer o design.
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  let agentsBackup: string | null = null;
  if (mode === "repair") {
    agentsBackup = await fs.readFile(agentsPath, "utf-8").catch(() => null);
    await fs.writeFile(agentsPath, REPAIR_AGENTS_MD, "utf-8").catch(() => {});
  }
  const restoreAgents = async () => {
    if (mode !== "repair") return;
    if (agentsBackup === null) {
      await fs.rm(agentsPath, { force: true }).catch(() => {});
    } else {
      await fs.writeFile(agentsPath, agentsBackup, "utf-8").catch(() => {});
    }
  };

  const beforeEdit = await fs
    .stat(indexHtmlPath)
    .then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))
    .catch(() => null);
  const prompt =
    mode === "repair"
      ? buildRepairPrompt({ leadName, violationsSummary: additionalPrompt || "" })
      : buildAutonomousSitePrompt({ leadName, niche, additionalPrompt });

  // Grava o prompt completo em PROMPT.md no workspace para evitar truncamento por shells (especialmente Windows cmd.exe)
  const promptFilePath = path.join(workspaceDir, "PROMPT.md");
  await fs.writeFile(promptFilePath, prompt, "utf-8");

  // Negação determinística de leitura de imagens: o gateway (9router) aceita no
  // máximo 8 imagens por prompt e elas acumulam no histórico da sessão. As fotos
  // já vão anexadas; abrir mais arquivos de imagem mata a sessão com erro 400.
  // Instrução de prompt não é garantia — a regra de permissão é.
  const workspaceConfigPath = path.join(workspaceDir, "opencode.json");
  try {
    await fs.access(workspaceConfigPath);
  } catch {
    await fs.writeFile(
      workspaceConfigPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          permissions: ["fotos/*", "fotos/**", "*.jpg", "*.jpeg", "*.png", "*.webp"].map(
            (resource) => ({ action: "read", resource, effect: "deny" })
          ),
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  const isWindows = process.platform === "win32";
  let binaryName = "opencode";
  let useShell = false;

  if (isWindows) {
    // No Windows, prefere o binário executável direto para evitar que o cmd.exe mutile argumentos ou flags
    const directExePath = path.join(
      path.dirname(process.execPath),
      "node_modules/@opencode/cli/bin/opencode.exe"
    );
    try {
      await fs.access(directExePath);
      binaryName = directExePath;
      useShell = false;
    } catch {
      binaryName = "opencode.cmd";
      useShell = true;
    }
  }

  const args = [
    "run",
    "--standalone",
    "--auto",
    "--format",
    "json",
    "-f",
    "PROMPT.md",
  ];

  // No modo repair nada além do PROMPT.md é anexado: briefing, design e fotos
  // empurram o agente para refazer a página inteira em vez de corrigir o HTML.
  if (mode === "build") {
    // Anexa AGENTS.md se existir (protocolo oficial de engenharia Impeccable)
    try {
      await fs.access(path.join(workspaceDir, "AGENTS.md"));
      args.push("-f", "AGENTS.md");
    } catch {}

    // Anexa PRODUCT.md se existir
    try {
      await fs.access(path.join(workspaceDir, "PRODUCT.md"));
      args.push("-f", "PRODUCT.md");
    } catch {}

    // Anexa DESIGN.md se existir
    try {
      await fs.access(path.join(workspaceDir, "DESIGN.md"));
      args.push("-f", "DESIGN.md");
    } catch {}

    // Anexa INFORMACOES-DO-NEGOCIO.txt se existir
    try {
      await fs.access(path.join(workspaceDir, "INFORMACOES-DO-NEGOCIO.txt"));
      args.push("-f", "INFORMACOES-DO-NEGOCIO.txt");
    } catch {}

    // Encontra fotos reais na pasta fotos/ e anexa até 4 fotos com visão multimodal.
    // Limite do gateway (9router): no máximo 8 imagens por prompt. Como as imagens
    // acumulam no histórico da sessão, anexar muitas faz o agente estourar o limite
    // quando ele abre os arquivos de imagem. Por isso: 4 anexadas + proibição de read.
    const photosDir = path.join(workspaceDir, "fotos");
    try {
      const files = await fs.readdir(photosDir);
      const imageFiles = files
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .sort()
        .slice(0, 4);

      for (const img of imageFiles) {
        args.push("-f", `fotos/${img}`);
      }
    } catch {}
  }

  if (model) {
    args.push("-m", model);
  }

  // Invocação canônica segura com referência direta aos artefatos anexados
  if (mode === "repair") {
    args.push(
      `Execute o MODO REPARO descrito em PROMPT.md: corrija os anti-patterns listados editando apenas o index.html existente e valide com o detector oficial até zerar.`
    );
  } else {
    args.push(
      `Siga rigorosamente as instruções de PROMPT.md e DESIGN.md anexados e crie o arquivo index.html autoral de alto padrão para ${leadName || "a empresa"} utilizando as fotos reais de ./fotos/.`,
      `ORÇAMENTO DE IMAGENS: o gateway aceita no máximo 8 imagens por prompt e elas ficam no histórico da sessão. As 4 fotos acima JÁ estão anexadas. NÃO abra arquivos .jpg/.png com a ferramenta read (a sessão morre com erro de gateway). Para conhecer nomes e dimensões das demais fotos use apenas shell.`
    );
  }

  let stdout = "";
  let stderr = "";

  return new Promise((resolve) => {
    let resolved = false;

    const child = spawn(binaryName, args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        // Garante que o OpenCode encontre suas configurações e tokens
        NODE_ENV: "production",
        // Aponta o provider "9router" do opencode.json para o gateway correto:
        // 127.0.0.1 em dev local, http://9router:20128/v1 no EasyPanel.
        ROUTER_BASE_URL: process.env.ROUTER_BASE_URL?.trim() || "http://127.0.0.1:20128/v1",
        ROUTER_API_KEY: process.env.ROUTER_API_KEY?.trim() || "sk-9router",
      },
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        void restoreAgents();
        resolve({
          success: false,
          generatedFiles: [],
          stdout,
          stderr: stderr + "\n[Timeout] Execução do OpenCode excedeu o limite de tempo.",
          durationMs: Date.now() - startTime,
          error: `Timeout de ${timeoutMs / 1000}s excedido.`,
        });
      }
    }, timeoutMs);

    let skillActivated = false;
    let productMdCreated = false;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;

      // Monitora ativação da Skill Impeccable em tempo real via JSON streaming do OpenCode
      if (!skillActivated && (text.includes('"tool":"skill"') || text.includes('"name":"impeccable"') || text.includes('"id":"impeccable"'))) {
        skillActivated = true;
        onLog?.("[OpenCode] 🎨 Skill /impeccable ativada com sucesso pelo agente.");
      }

      // Monitora progresso de artefatos essenciais da skill
      if (!productMdCreated && text.includes("PRODUCT.md")) {
        productMdCreated = true;
        onLog?.("[OpenCode] 📋 Impeccable iniciou modelagem de produto (PRODUCT.md).");
      }

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === "tool_use" && parsed.part) {
            const toolName = parsed.part.tool || parsed.part.name || "ferramenta";
            onLog?.(`[OpenCode Tool] Executando: ${toolName}`);
          } else if (parsed.type === "step_start") {
            onLog?.(`[OpenCode Step] Avançando etapa de raciocínio...`);
          } else if (parsed.type === "text" && parsed.part?.text) {
            const preview = parsed.part.text.trim().split("\n")[0]?.slice(0, 100);
            if (preview) onLog?.(`[OpenCode Resposta] ${preview}`);
          }
        } catch {
          // não é JSON, repassa se houver handler
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (onLog) onLog(text);
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        void restoreAgents();
        resolve({
          success: false,
          generatedFiles: [],
          stdout,
          stderr: stderr + `\n[Erro Spawn] ${err.message}`,
          durationMs: Date.now() - startTime,
          error: `Falha ao iniciar processo do OpenCode: ${err.message}`,
        });
      }
    });

    child.on("close", async (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      await restoreAgents();

      // Inspeciona arquivos gerados na pasta do workspace
      const generatedFiles: string[] = [];
      try {
        const files = await fs.readdir(workspaceDir);
        for (const f of files) {
          if (["index.html", "styles.css", "tokens.css", "script.js", "main.js"].includes(f)) {
            generatedFiles.push(f);
          }
        }
      } catch {
        // ignora
      }

      // O sucesso exige que index.html tenha sido gerado
      const hasIndexHtml = generatedFiles.includes("index.html");
      let detectorReport: ImpeccableDetectResult | undefined;

      if (hasIndexHtml) {
        const indexHtmlPath = path.join(workspaceDir, "index.html");
        try {
          // 1. Executa o detector oficial do Impeccable
          detectorReport = await detectImpeccableAntiPatterns(indexHtmlPath);

          if (!detectorReport.clean || detectorReport.issuesCount > 0) {
            onLog?.(`[Impeccable Detector] ⚠️ ${detectorReport.issuesCount} anti-patterns detectados: ${detectorReport.issues.join(", ")}. Aplicando sanitização automática do Craft Floor...`);
            const rawContent = await fs.readFile(indexHtmlPath, "utf-8");
            const sanitizedContent = sanitizeHtmlForImpeccable(rawContent);
            const sanitizedCss = validateHtmlCss(sanitizedContent);

            if (!sanitizedCss.valid) {
              onLog?.(`[CSS Validator] ❌ Sanitização abortada (resultado não parseia): ${sanitizedCss.errors.join("; ")}. HTML original preservado.`);
            } else {
              await fs.writeFile(indexHtmlPath, sanitizedContent, "utf-8");

              // 2. Re-executa o detector oficial para validar que ficou 100% limpo
              detectorReport = await detectImpeccableAntiPatterns(indexHtmlPath);
              if (detectorReport.clean) {
                onLog?.(`[Impeccable Detector] ✅ HTML 100% limpo! Zero anti-patterns detectados pelo binário oficial.`);
              } else {
                onLog?.(`[Impeccable Detector] ⚠️ Restam ${detectorReport.issuesCount} itens: ${detectorReport.issues.join(", ")}`);
              }
            }
          } else {
            onLog?.(`[Impeccable Detector] ✅ HTML gerado diretamente com ZERO anti-patterns detectados pelo binário oficial.`);
          }

          // 3. Sintaxe CSS sempre validada (o detector oficial NÃO pega CSS inválido).
          const finalCss = validateHtmlCss(await fs.readFile(indexHtmlPath, "utf-8"));
          if (!finalCss.valid) {
            onLog?.(`[CSS Validator] ❌ CSS inválido no index.html: ${finalCss.errors.join("; ")}`);
          } else {
            onLog?.(`[CSS Validator] ✅ ${finalCss.styleBlocks} bloco(s) <style> parseando sem erro.`);
          }
        } catch (detErr: any) {
          onLog?.(`[Impeccable Detector] Erro na validação: ${detErr?.message}`);
        }
      }

      const afterEdit = await fs
        .stat(indexHtmlPath)
        .then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }))
        .catch(() => null);
      const fileChanged =
        !beforeEdit || !afterEdit
          ? Boolean(beforeEdit) !== Boolean(afterEdit)
          : afterEdit.mtimeMs !== beforeEdit.mtimeMs || afterEdit.size !== beforeEdit.size;

      // Erro de provider (modelo inexistente, gateway fora) sai no stdout/stderr.
      const providerError = /provider\.(no-route|error)|Model unavailable|No active credentials|has reached its end of life|"type"\s*:\s*"error"/i.test(
        `${stdout}\n${stderr}`
      );
      if (providerError) {
        const msg =
          stdout.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ||
          stderr.match(/Error:\s*(\[[^\n]+)/)?.[1] ||
          "Erro de provider no OpenCode";
        resolve({
          success: false,
          generatedFiles: [],
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          error: `OpenCode falhou: ${msg}`,
          detectorReport,
        });
        return;
      }

      // Em modo repair, sucesso exige que o index.html tenha mudado de fato.
      const success =
        mode === "repair"
          ? code === 0 && hasIndexHtml && fileChanged
          : (code === 0 || hasIndexHtml) && hasIndexHtml;

      resolve({
        success,
        generatedFiles,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        skillActivated: skillActivated || stdout.includes('"id":"impeccable"') || stdout.includes('"tool":"skill"'),
        error: success
          ? undefined
          : mode === "repair"
            ? `OpenCode finalizou com código ${code} sem alterar o index.html.`
            : `OpenCode finalizou com código ${code} ou sem index.html gerado.`,
        detectorReport,
      });
    });
  });
}
