import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  detectImpeccableAntiPatterns,
  sanitizeHtmlForImpeccable,
  type ImpeccableDetectResult,
} from "./impeccable-detector";

export interface OpenCodeRunOptions {
  workspaceDir: string;
  leadName?: string;
  niche?: string;
  additionalPrompt?: string;
  model?: string;
  timeoutMs?: number;
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
 * Constrói o prompt especializado para o OpenCode CLI utilizar com a Skill Impeccable.
 */
export function buildAutonomousSitePrompt(opts: {
  leadName?: string;
  niche?: string;
  additionalPrompt?: string;
}): string {
  const { leadName = "Empresa", niche = "Serviços Locais", additionalPrompt } = opts;

  return [
    `/impeccable "Landing page comercial autoral em index.html para ${leadName} (Nicho: ${niche})"`,
    ``,
    `Analise a fundo o nicho "${niche}", os dados reais em INFORMACOES-DO-NEGOCIO.txt e o acervo de fotos em ./fotos/ para projetar a melhor experiência digital possível para ${leadName}.`,
    ``,
    `DIRETRIZES DA CRIAÇÃO:`,
    `- IDENTIDADE VISUAL & LOGO: Inspecione as fotos reais em ./fotos/. Se houver logotipo, fachada ou paleta física do local, derive as cores dominantes e a direção estética dessa identidade real. O site precisa ser autoral e feito sob medida para essa marca, sem parecer template genérico.`,
    `- ANIMAÇÕES & FLUIDEZ: Crie animações e microinterações elegantes em CSS/JS que conversem harmonicamente com o estilo do logo e a energia do nicho (revelações suaves ao rolar a página, transições a 60fps, microinterações táteis nos botões e links).`,
    `- ACERVO REAL: Utilize as fotos reais autênticas de ./fotos/ distribuídas estrategicamente pelo site (Hero, serviços, resultados/galeria e ambiente). Não repita a mesma foto em seções diferentes.`,
    `- ENTREGA: Gere o código completo e autossuficiente diretamente em 'index.html', com alta conversão para WhatsApp e prova social baseada nas avaliações reais.`,
    additionalPrompt ? `\nORIENTAÇÃO ESPECÍFICA:\n${additionalPrompt}` : "",
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
    model = process.env.OPENCODE_MODEL || "9router/combo-principal",
    timeoutMs = 660_000, // 11 minutos para sites completos com refinamento e pós-processamento
    onLog,
  } = opts;

  const startTime = Date.now();
  const prompt = buildAutonomousSitePrompt({ leadName, niche, additionalPrompt });

  // Grava o prompt completo em PROMPT.md no workspace para evitar truncamento por shells (especialmente Windows cmd.exe)
  const promptFilePath = path.join(workspaceDir, "PROMPT.md");
  await fs.writeFile(promptFilePath, prompt, "utf-8");

  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "opencode.cmd" : "opencode";

  const args = [
    "run",
    "--standalone",
    "--auto",
    "--format",
    "json",
    "-f",
    "PROMPT.md",
  ];

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

  // Encontra fotos reais na pasta fotos/ e anexa até 6 fotos com visão multimodal
  const photosDir = path.join(workspaceDir, "fotos");
  try {
    const files = await fs.readdir(photosDir);
    const imageFiles = files
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort()
      .slice(0, 6);

    for (const img of imageFiles) {
      args.push("-f", `fotos/${img}`);
    }
  } catch {}

  if (model) {
    args.push("-m", model);
  }

  // Invocação canônica da Skill Impeccable no OpenCode CLI
  args.push(
    `/impeccable Landing page autoral em index.html para ${leadName || "a empresa"} (Nicho: ${niche || "Serviços Locais"}). Siga integralmente o PROMPT.md anexado, com INFORMACOES-DO-NEGOCIO.txt, DESIGN.md e todo o acervo de ./fotos/.`
  );

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
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
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

      if (onLog) onLog(text);
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
            await fs.writeFile(indexHtmlPath, sanitizedContent, "utf-8");

            // 2. Re-executa o detector oficial para validar que ficou 100% limpo
            detectorReport = await detectImpeccableAntiPatterns(indexHtmlPath);
            if (detectorReport.clean) {
              onLog?.(`[Impeccable Detector] ✅ HTML 100% limpo! Zero anti-patterns detectados pelo binário oficial.`);
            } else {
              onLog?.(`[Impeccable Detector] ⚠️ Restam ${detectorReport.issuesCount} itens: ${detectorReport.issues.join(", ")}`);
            }
          } else {
            onLog?.(`[Impeccable Detector] ✅ HTML gerado diretamente com ZERO anti-patterns detectados pelo binário oficial.`);
          }
        } catch (detErr: any) {
          onLog?.(`[Impeccable Detector] Erro na validação: ${detErr?.message}`);
        }
      }

      const success = (code === 0 || hasIndexHtml) && hasIndexHtml;

      resolve({
        success,
        generatedFiles,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        skillActivated: skillActivated || stdout.includes('"id":"impeccable"') || stdout.includes('"tool":"skill"'),
        error: success ? undefined : `OpenCode finalizou com código ${code} ou sem index.html gerado.`,
        detectorReport,
      });
    });
  });
}
