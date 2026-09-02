import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import fs from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ success: false, error: "Apenas admin" }, { status: 403 });
  }
  const results: Record<string, any> = {};

  // 1. Environment
  results.env = {
    WHISPER_MODEL: process.env.WHISPER_MODEL || "(not set)",
    WHISPER_DISABLED: process.env.WHISPER_DISABLED || "(not set)",
    NODE_ENV: process.env.NODE_ENV,
    PLATFORM: process.platform,
    ARCH: process.arch,
  };

  // 2. Whisper dir
  const dir = process.env.WHISPER_DIR || path.join(process.cwd(), ".whisper");
  results.whisperDir = dir;
  results.whisperDirExists = fs.existsSync(dir);

  if (fs.existsSync(dir)) {
    // List all files recursively (max depth 3)
    const allFiles: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p, depth + 1); continue; }
          const stat = fs.statSync(p);
          allFiles.push(`${path.relative(dir, p)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        }
      } catch {}
    };
    walk(dir, 0);
    results.whisperFiles = allFiles;

    // Check bin-path.txt
    const binPathFile = path.join(dir, "bin-path.txt");
    if (fs.existsSync(binPathFile)) {
      const binPath = fs.readFileSync(binPathFile, "utf8").trim();
      results.whisperBinPath = binPath;
      results.whisperBinExists = fs.existsSync(binPath);

      // CRITICAL: actually try to EXECUTE the binary with --help
      if (fs.existsSync(binPath)) {
        try {
          const { stdout, stderr } = await execFileAsync(binPath, ["--help"], { timeout: 10000 });
          results.whisperBinExec = { ok: true, output: (stdout || stderr).slice(0, 300) };
        } catch (e: any) {
          results.whisperBinExec = {
            ok: false,
            error: e?.message?.slice(0, 300),
            stderr: e?.stderr?.slice(0, 300),
            code: e?.code,
          };
        }
      }
    } else {
      results.whisperBinPath = "(bin-path.txt not found)";
    }

    // Check models
    const models = allFiles.filter(f => /^ggml-.*\.bin/.test(f));
    results.models = models;
  }

  // 3. ffmpeg
  try {
    const ver = execFileSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 5000 });
    results.ffmpeg = { ok: true, version: ver.slice(0, 80) };
  } catch (e: any) {
    results.ffmpeg = { ok: false, error: e?.message?.slice(0, 200) };
  }

  // 4. Try actual transcription with a tiny test audio
  try {
    const { transcribeAudioWithWhisper, getWhisperStatus, isWhisperInstalled } = await import("@/lib/whisper-manager");
    results.whisperStatus = await getWhisperStatus();
    results.whisperIsInstalled = isWhisperInstalled();
  } catch (e: any) {
    results.whisperStatus = { error: e?.message?.slice(0, 200) };
  }

  return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
}
