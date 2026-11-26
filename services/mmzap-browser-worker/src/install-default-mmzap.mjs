import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MMZAP_EXTENSION_ID = process.env.MMZAP_EXTENSION_ID || "dbogohdpdjiogkibmneanejjcbcdplfd";
const TARGET_DIR = path.resolve(process.env.DEFAULT_EXTENSION_DIR || "/opt/mmzap-extension");
const MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.MMZAP_INSTALL_RETRIES || 3) || 3));
const FETCH_TIMEOUT_MS = Math.max(10_000, Number(process.env.MMZAP_INSTALL_TIMEOUT_MS || 30_000) || 30_000);
const BASE_BACKOFF_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function validateExtractedExtensionDir(dir) {
  let sourceDir = dir;
  let manifestPath = path.join(sourceDir, "manifest.json");

  if (!(await fileExists(manifestPath))) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const firstDir = entries.find((entry) => entry.isDirectory());
    if (firstDir && (await fileExists(path.join(dir, firstDir.name, "manifest.json")))) {
      sourceDir = path.join(dir, firstDir.name);
      manifestPath = path.join(sourceDir, "manifest.json");
    } else {
      throw new Error(`manifest.json não encontrado após extração em ${dir}`);
    }
  }

  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    throw new Error(
      `manifest.json inválido (JSON malformado): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest.json não contém um objeto JSON válido");
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("manifest.json sem campo 'name' válido");
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("manifest.json sem campo 'version' válido");
  }
  if (typeof manifest.manifest_version !== "number" || manifest.manifest_version < 2) {
    throw new Error(`manifest.json com manifest_version inválido: ${String(manifest.manifest_version)}`);
  }

  const extractedEntries = await fs.readdir(sourceDir);
  if (extractedEntries.length < 2) {
    throw new Error("Pacote da extensão extraído parece incompleto (menos de 2 arquivos)");
  }

  return { sourceDir, manifest };
}

async function downloadAndInstallOnce(attempt) {
  const crxUrl =
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=133.0.0.0` +
    `&acceptformat=crx2,crx3&x=id%3D${encodeURIComponent(MMZAP_EXTENSION_ID)}%26uc`;

  console.log(
    `[install-default-mmzap] Tentativa ${attempt}/${MAX_ATTEMPTS}: baixando extensão oficial ${MMZAP_EXTENSION_ID}...`
  );

  const res = await fetch(crxUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Falha HTTP ${res.status} ao baixar CRX da Chrome Web Store`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 16) {
    throw new Error(`Payload CRX truncado (${buf.length} bytes)`);
  }
  if (buf.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error(`Cabeçalho CRX inválido: ${buf.subarray(0, 4).toString("hex")}`);
  }

  const version = buf.readUInt32LE(4);
  let zipOffset = 0;
  if (version === 3) {
    zipOffset = 12 + buf.readUInt32LE(8);
  } else if (version === 2) {
    zipOffset = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  } else {
    throw new Error(`Versão CRX não suportada: ${version}`);
  }

  if (zipOffset <= 0 || zipOffset >= buf.length - 4) {
    throw new Error(`Offset ZIP inválido (${zipOffset}) para CRX de ${buf.length} bytes`);
  }

  const zipBuf = buf.subarray(zipOffset);
  if (zipBuf.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("Payload ZIP interno inválido após extração do cabeçalho CRX");
  }

  const tmpBase = os.tmpdir() || "/tmp";
  const stamp = `${Date.now()}-${attempt}`;
  const tmpZip = path.join(tmpBase, `mmzap-default-${stamp}.zip`);
  const tmpStage = path.join(tmpBase, `mmzap-stage-${stamp}`);

  await fs.writeFile(tmpZip, zipBuf);
  await fs.mkdir(tmpStage, { recursive: true });

  try {
    await execFileAsync("unzip", ["-o", tmpZip, "-d", tmpStage]);

    const { sourceDir } = await validateExtractedExtensionDir(tmpStage);

    await fs.rm(TARGET_DIR, { recursive: true, force: true });
    await fs.mkdir(TARGET_DIR, { recursive: true });
    await fs.cp(sourceDir, TARGET_DIR, { recursive: true });

    // Validação final no diretório de destino para garantir integridade no container Docker
    const { manifest: installedManifest } = await validateExtractedExtensionDir(TARGET_DIR);
    console.log(
      `[install-default-mmzap] Instalado e validado com sucesso em ${TARGET_DIR}: ${installedManifest.name} v${installedManifest.version} (MV${installedManifest.manifest_version})`
    );
  } finally {
    await fs.rm(tmpZip, { force: true }).catch(() => {});
    await fs.rm(tmpStage, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await downloadAndInstallOnce(attempt);
      return;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[install-default-mmzap] Tentativa ${attempt}/${MAX_ATTEMPTS} falhou: ${msg}`
      );
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
        console.log(`[install-default-mmzap] Aguardando ${backoffMs}ms antes da próxima tentativa...`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError || new Error("Falha ao instalar extensão padrão MMZap após múltiplas tentativas");
}

main().catch((err) => {
  console.error("[install-default-mmzap] Erro fatal após todas as tentativas:", err);
  process.exit(1);
});
