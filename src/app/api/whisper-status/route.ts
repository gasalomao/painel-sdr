import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = 'force-dynamic';

export async function GET() {
  const results: Record<string, unknown> = {};

  // 1. Whisper status
  try {
    const { getWhisperStatus, isWhisperInstalled } = await import("@/lib/whisper-manager");
    results.whisper = {
      installed: isWhisperInstalled(),
      status: await getWhisperStatus(),
    };
  } catch (e: any) {
    results.whisper = { error: e?.message };
  }

  // 2. ffmpeg
  try {
    const { execFileSync } = await import("child_process");
    const ver = execFileSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 5000 });
    results.ffmpeg = { ok: true, version: ver.slice(0, 60) };
  } catch (e: any) {
    results.ffmpeg = { ok: false, error: e?.message?.slice(0, 120) };
  }

  // 3. Environment
  results.env = {
    WHISPER_MODEL: process.env.WHISPER_MODEL || "(not set)",
    WHISPER_DISABLED: process.env.WHISPER_DISABLED || "(not set)",
    NODE_ENV: process.env.NODE_ENV,
  };

  // 4. Whisper dir contents
  try {
    const { readFileSync, readdirSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const os = await import("os");
    const dir = process.env.WHISPER_DIR || join(process.cwd(), ".whisper");
    results.whisperDir = dir;
    if (existsSync(dir)) {
      const files = readdirSync(dir);
      results.whisperDirFiles = files;
      const binPath = join(dir, "bin-path.txt");
      if (existsSync(binPath)) {
        results.whisperBinPath = readFileSync(binPath, "utf8").trim();
      }
    } else {
      results.whisperDirFiles = "(dir not found)";
    }
  } catch (e: any) {
    results.whisperDir = { error: e?.message };
  }

  return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
}
