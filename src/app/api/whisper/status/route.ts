import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { getWhisperStatus } from "@/lib/whisper-manager";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ success: false, error: "Apenas admin" }, { status: 403 });
  }
  const status = await getWhisperStatus();

  let ffmpegAvailable = false;
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  return NextResponse.json({
    ...status,
    ffmpegAvailable,
    platform: process.platform,
    recommendation: !status.installed && !status.disabled
      ? "Whisper será baixado automaticamente no 1º áudio. FFmpeg é necessário."
      : status.disabled
      ? "Whisper desligado via WHISPER_DISABLED. Transcrição usa Gemini (gasta tokens)."
      : !ffmpegAvailable
      ? "FFmpeg não encontrado — whisper não consegue converter áudio. Instale ffmpeg."
      : "Tudo OK — whisper local (grátis) é primário, Gemini é fallback.",
  });
}
