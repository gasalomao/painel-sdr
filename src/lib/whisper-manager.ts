/**
 * Whisper.cpp — transcrição de áudio GRATUITA e LOCAL (sem API, sem token).
 *
 * POR QUE EXISTE: o painel transcrevia áudios só com o Gemini (multimodal),
 * gastando token. Aqui é a alternativa 100% grátis: o whisper.cpp roda no
 * próprio servidor (CPU), baixado uma vez e cacheado em disco. Ideal pra quem
 * não quer/tem API key ou quer economizar. O fluxo do webhook chama o whisper
 * PRIMEIRO; se falhar, cai pro Gemini (fallback) — nunca perde um áudio.
 *
 * COMO FUNCIONA:
 *   1. ensureWhisper(): baixa o binário (whisper-bin-ubuntu-x64) + modelo
 *      (ggml-base.bin, 74MB) em runtime pro disco (.whisper/). Idempotente —
 *      só baixa 1x, cacheia. Mesmo padrão do conector embutido (CLIProxyAPI).
 *   2. transcribeAudioWithWhisper(base64, mime): decodifica o áudio, converte
 *      pra WAV 16kHz (whisper.cpp exige) com ffmpeg, roda whisper-cli em CPU
 *      e devolve o texto. Retorna null em falha (caller cai no fallback).
 *
 * Requisitos no container: ffmpeg + libc6-compat (binário Ubuntu roda no Alpine
 * via libc6-compat). Veja Dockerfile.
 *
 * Server-only (fs/child_process). Env WHISPER_DISABLED=1 desliga (cai direto
 * no Gemini). Env WHISPER_MODEL troca o modelo (default ggml-base.bin).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const WHISPER_DISABLED = /^(1|true|yes)$/i.test(process.env.WHISPER_DISABLED || "");

/**
 * Diretório do whisper (binário + modelo). Mesma estratégia do gateway-proxy:
 * env → cwd → tmp (sempre gravável).
 */
function dirWritable(d: string): boolean {
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseDir(): string {
  const candidates = [
    process.env.WHISPER_DIR,
    path.join(process.cwd(), ".whisper"),
    path.join(os.tmpdir(), "painel-whisper"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (dirWritable(c)) return c;
  return path.join(process.cwd(), ".whisper");
}

const DIR = resolveBaseDir();
const BIN_DIR = path.join(DIR, "bin");
const MODEL_NAME = process.env.WHISPER_MODEL || "ggml-base.bin";
const MODEL_PATH = path.join(DIR, MODEL_NAME);
const BIN_PATH = path.join(BIN_DIR, "whisper-cli");
const BINPATH_PATH = path.join(DIR, "bin-path.txt");

// Releases oficiais: github.com/ggml-org/whisper.cpp/releases
const WHISPER_VERSION = "v1.7.5"; // pinado pra estabilidade; bump manual
// Binário certo por plataforma — antes baixava só o binário Linux e QUEBRAVA
// no Windows do usuário (wine não existe). Agora win32 baixa .zip com .exe.
const IS_WINDOWS = process.platform === "win32";
const BIN_ASSET = IS_WINDOWS
  ? "whisper-bin-x64.zip"
  : "whisper-bin-ubuntu-x64.tar.gz";
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${BIN_ASSET}`;
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;

function readText(p: string): string | null {
  try { return fs.readFileSync(p, "utf8").trim() || null; } catch { return null; }
}

/**
 * Binário do whisper está pronto? Checa o bin-path.txt (aponta pro executável
 * real, que pode estar em subpasta do tar.gz extraído).
 */
export function isWhisperInstalled(): boolean {
  const p = readText(BINPATH_PATH);
  return !!(p && fs.existsSync(p) && fs.existsSync(MODEL_PATH));
}

/**
 * Baixa e instala o whisper (binário + modelo) em runtime. Idempotente — só
 * baixa o que falta. Mesmo padrão do installProxy() do gateway-proxy-manager.
 * Pode demorar na 1ª vez (~74MB modelo + ~9MB binário); depois é instantâneo.
 */
export async function ensureWhisper(): Promise<{ binPath: string; modelPath: string }> {
  if (WHISPER_DISABLED) throw new Error("Whisper desligado via WHISPER_DISABLED.");
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // 1) Binário — baixa o tar.gz, extrai, acha o whisper-cli.
  let binPath = readText(BINPATH_PATH);
  if (!binPath || !fs.existsSync(binPath)) {
    const archivePath = path.join(DIR, BIN_ASSET);
    const res = await fetch(BIN_URL, {
      headers: { "User-Agent": "painel-sdr" },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Download do whisper falhou (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archivePath, buf);

    await extractArchive(archivePath, BIN_DIR);
    try { fs.unlinkSync(archivePath); } catch { /* não-fatal */ }

    binPath = findWhisperBinary(BIN_DIR);
    if (!binPath) throw new Error("Binário whisper-cli não encontrado após extrair.");
    if (process.platform !== "win32") {
      try { fs.chmodSync(binPath, 0o755); } catch { /* não-fatal */ }
    }
    fs.writeFileSync(BINPATH_PATH, binPath, "utf8");
  }

  // 2) Modelo — baixa do HuggingFace (74MB pra ggml-base.bin). Cacheado.
  if (!fs.existsSync(MODEL_PATH)) {
    const res = await fetch(MODEL_URL, {
      headers: { "User-Agent": "painel-sdr" },
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) throw new Error(`Download do modelo whisper falhou (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(MODEL_PATH, buf);
  }

  return { binPath, modelPath: MODEL_PATH };
}

/** Extrai tar.gz (Linux/Mac) ou zip (Windows). */
function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (archivePath.endsWith(".zip")) {
      const script = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) =>
        err ? reject(new Error(`Falha ao extrair zip: ${err.message}`)) : resolve()
      );
    } else {
      execFile("tar", ["-xzf", archivePath, "-C", destDir], (err) =>
        err ? reject(new Error(`Falha ao extrair tar.gz: ${err.message}`)) : resolve()
      );
    }
  });
}

/** Acha o executável whisper-cli dentro da pasta extraída (nomes variam). */
function findWhisperBinary(dir: string): string | null {
  const candidates: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const isExe = process.platform === "win32"
        ? e.name.toLowerCase().endsWith(".exe")
        : !e.name.includes(".") || e.name.endsWith(".bin");
      if (!isExe) continue;
      if (/whisper-cli|main|whisper/i.test(e.name)) candidates.push(p);
    }
  };
  walk(dir, 0);
  // Prefere whisper-cli; senão o primeiro candidato executável.
  return candidates.find((p) => /whisper-cli/i.test(p)) || candidates[0] || null;
}

export interface WhisperStatus {
  installed: boolean;
  disabled: boolean;
  model: string;
}

/** Status rápido do whisper (instalado? desligado? qual modelo?). */
export async function getWhisperStatus(): Promise<WhisperStatus> {
  return {
    installed: isWhisperInstalled(),
    disabled: WHISPER_DISABLED,
    model: MODEL_NAME,
  };
}

/**
 * Transcreve um áudio (base64) usando whisper.cpp local. Devolve o texto ou
 * `null` em falha (caller cai no fallback Gemini). Formata esperado pelo
 * webhook: recebe o base64 do WhatsApp (audio/ogg; codecs=opus), decodifica,
 * converte pra WAV 16kHz mono (exigência do whisper.cpp), roda o binário em CPU.
 *
 * @param base64      Áudio em base64 (pode ter prefixo data:...;base64,)
 * @param mimetype    Mime (audio/ogg, audio/mpeg, etc.)
 * @param timeoutMs   Timeout (default 60s — áudios longos em CPU podem demorar)
 */
export async function transcribeAudioWithWhisper(
  base64: string,
  mimetype: string,
  timeoutMs = 60000,
): Promise<string | null> {
  if (WHISPER_DISABLED) return null;
  if (!isWhisperInstalled()) {
    try { await ensureWhisper(); } catch { return null; }
  }
  const binPath = readText(BINPATH_PATH);
  if (!binPath || !fs.existsSync(binPath) || !fs.existsSync(MODEL_PATH)) return null;

  // Decodifica base64 → arquivo temporário com extensão certa.
  const cleanBase64 = base64.replace(/^data:.*?;base64,/, "");
  const ext = (mimetype || "").includes("mpeg") ? ".mp3"
    : (mimetype || "").includes("wav") ? ".wav"
    : (mimetype || "").includes("m4a") ? ".m4a"
    : ".ogg";
  const tmpDir = path.join(os.tmpdir(), `painel-whisper-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, `input${ext}`);
  const wavPath = path.join(tmpDir, "input.wav");
  const txtPath = path.join(tmpDir, "input.txt");

  try {
    fs.writeFileSync(inputPath, Buffer.from(cleanBase64, "base64"));

    // Converte pra WAV 16kHz mono PCM — formato que o whisper.cpp exige.
    // -ar 16000 (sample rate), -ac 1 (mono), -c:a pcm_s16le (16-bit PCM).
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-i", inputPath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wavPath,
      ], { timeout: 20000 });
    } catch (ffmpegErr: any) {
      // ffmpeg ausente (comum em Windows sem instalar) ou áudio inválido.
      // Retorna null pra chamar fallback Gemini (multimodal) — nunca perde áudio.
      console.warn(
        "[whisper] ffmpeg falhou (instale ffmpeg ou use WHISPER_DISABLED=1 pra pular direto pro Gemini):",
        ffmpegErr?.message?.slice(0, 120)
      );
      return null;
    }
    if (!fs.existsSync(wavPath)) return null;

    // Roda o whisper-cli. Flags:
    //   -m modelo  -f arquivo  -l pt (português)  -t 2 (threads)
    //   -otxt (saída .txt)  -np (sem progress bar colorida)  -nt (sem timestamps)
    const result = await new Promise<string | null>((resolve) => {
      const child = spawn(binPath, [
        "-m", MODEL_PATH,
        "-f", wavPath,
        "-l", "pt",
        "-t", "2",
        "-otxt",
        "-np",
        "-nt",
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* já morto */ }
        resolve(null);
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.warn(`[whisper] whisper-cli saiu com código ${code}:`, stderr.slice(0, 200));
          resolve(null);
          return;
        }
        // O whisper escreve o resultado em input.txt (ao lado do wav).
        try {
          if (fs.existsSync(txtPath)) {
            const text = fs.readFileSync(txtPath, "utf8").trim();
            resolve(text || null);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
      child.on("error", () => { clearTimeout(timer); resolve(null); });
    });

    return result;
  } catch (err: any) {
    console.warn("[whisper] falha transcrevendo:", err?.message);
    return null;
  } finally {
    // Limpa temporários sempre.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
