import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface VercelDeployOptions {
  workspaceDir: string;
  projectName: string;
  token?: string;
  teamId?: string;
}

export interface VercelDeployResult {
  success: boolean;
  url?: string;
  deploymentId?: string;
  error?: string;
}

interface VercelFilePayload {
  file: string;
  data: string;
  encoding: "utf-8" | "base64";
}

/**
 * Lê recursivamente os arquivos do workspace e empacota para a API da Vercel.
 * Filtra fotos não utilizadas no index.html para manter o payload leve e o deploy veloz.
 */
async function collectFilesForDeploy(
  dir: string,
  baseDir: string,
  indexContent?: string
): Promise<VercelFilePayload[]> {
  const result: VercelFilePayload[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    // Ignora pastas e arquivos desnecessários
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "INFORMACOES-DO-NEGOCIO.txt" ||
      entry.name === "PROMPT.md" ||
      entry.name.endsWith(".md")
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await collectFilesForDeploy(fullPath, baseDir, indexContent);
      result.push(...nested);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const isBinary = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".svg"].includes(ext);

      // Se for foto dentro de fotos/, só envia se estiver realmente citada no index.html
      if (relPath.startsWith("fotos/") && indexContent) {
        const fileName = path.basename(relPath);
        if (!indexContent.includes(relPath) && !indexContent.includes(fileName)) {
          continue; // Foto não utilizada no layout, poupa payload
        }
      }

      if (isBinary) {
        const buffer = await fs.readFile(fullPath);
        result.push({
          file: relPath,
          data: buffer.toString("base64"),
          encoding: "base64",
        });
      } else {
        const text = await fs.readFile(fullPath, "utf-8");
        result.push({
          file: relPath,
          data: text,
          encoding: "utf-8",
        });
      }
    }
  }

  return result;
}

/**
 * Normaliza o nome do projeto para o padrão da Vercel (letras minúsculas, números e hífens).
 */
export function sanitizeVercelProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "preview-site"
  );
}

/**
 * Realiza o deploy do workspace diretamente via REST API da Vercel v13.
 */
export async function deployToVercel(
  optsOrDir: VercelDeployOptions | string,
  maybeProjectName?: string
): Promise<VercelDeployResult> {
  const opts: VercelDeployOptions =
    typeof optsOrDir === "string"
      ? { workspaceDir: optsOrDir, projectName: maybeProjectName || "preview-site" }
      : optsOrDir;

  const { workspaceDir, projectName } = opts;
  const token = opts.token || process.env.VERCEL_TOKEN;
  const teamId = opts.teamId || process.env.VERCEL_TEAM_ID;

  if (!token) {
    return {
      success: false,
      error: "VERCEL_TOKEN não configurado nas variáveis de ambiente.",
    };
  }

  try {
    let indexContent = "";
    try {
      indexContent = await fs.readFile(path.join(workspaceDir, "index.html"), "utf-8");
    } catch {}

    const files = await collectFilesForDeploy(workspaceDir, workspaceDir, indexContent);

    if (files.length === 0 || !files.some((f) => f.file === "index.html")) {
      return {
        success: false,
        error: "index.html não encontrado no workspace para deploy.",
      };
    }

    const safeName = sanitizeVercelProjectName(projectName);
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const endpoint = `https://api.vercel.com/v13/deployments${query}`;

    const body = {
      name: safeName,
      files,
      projectSettings: {
        framework: null,
      },
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        error: `Erro HTTP ${res.status} da Vercel API: ${errText.slice(0, 300)}`,
      };
    }

    const deployData = (await res.json()) as any;
    const deploymentId = deployData.id;
    let finalUrl = deployData.url ? `https://${deployData.url}` : undefined;

    // Garante que a prévia seja pública desativando proteção SSO/senha no projeto Vercel
    try {
      await fetch(`https://api.vercel.com/v9/projects/${safeName}${query}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ssoProtection: null,
          passwordProtection: null,
        }),
      });
    } catch {
      // best-effort
    }

    // Se a Vercel retornou BUILDING/INITIALIZING, faz polling curto (até 15s) até ficar READY
    if (deployData.readyState && deployData.readyState !== "READY" && deploymentId) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const checkRes = await fetch(
            `https://api.vercel.com/v13/deployments/${deploymentId}${query}`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (checkRes.ok) {
            const checkData = (await checkRes.json()) as any;
            if (checkData.readyState === "READY") {
              finalUrl = `https://${checkData.url || deployData.url}`;
              break;
            }
          }
        } catch {
          // ignora falha de polling
        }
      }
    }

    return {
      success: true,
      url: finalUrl,
      deploymentId,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Exceção durante deploy Vercel: ${err.message}`,
    };
  }
}
