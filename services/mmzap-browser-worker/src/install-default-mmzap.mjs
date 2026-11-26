import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MMZAP_EXTENSION_ID = process.env.MMZAP_EXTENSION_ID || "dbogohdpdjiogkibmneanejjcbcdplfd";
const TARGET_DIR = path.resolve(process.env.DEFAULT_EXTENSION_DIR || "/opt/mmzap-extension");

async function main() {
  const crxUrl =
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=133.0.0.0` +
    `&acceptformat=crx2,crx3&x=id%3D${encodeURIComponent(MMZAP_EXTENSION_ID)}%26uc`;

  console.log(`[install-default-mmzap] Baixando extensão oficial ${MMZAP_EXTENSION_ID}...`);
  const res = await fetch(crxUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Falha HTTP ${res.status} ao baixar CRX da Chrome Web Store`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
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

  const zipBuf = buf.subarray(zipOffset);
  if (zipBuf.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("Payload ZIP interno inválido após extração do cabeçalho CRX");
  }

  const tmpZip = `/tmp/mmzap-default-${Date.now()}.zip`;
  await fs.writeFile(tmpZip, zipBuf);

  try {
    await fs.rm(TARGET_DIR, { recursive: true, force: true });
    await fs.mkdir(TARGET_DIR, { recursive: true });
    await execFileAsync("unzip", ["-o", tmpZip, "-d", TARGET_DIR]);

    const manifestRaw = await fs.readFile(path.join(TARGET_DIR, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    console.log(
      `[install-default-mmzap] Instalado com sucesso em ${TARGET_DIR}: ${manifest.name} v${manifest.version}`
    );
  } finally {
    await fs.rm(tmpZip, { force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[install-default-mmzap] Erro:", err);
  process.exit(1);
});
