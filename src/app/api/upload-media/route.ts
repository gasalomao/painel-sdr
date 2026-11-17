import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { resolveSafeUploadFormat } from "@/lib/media-upload-safety";

export const dynamic = "force-dynamic";

const MEDIA_BUCKET = "chat-media";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB — limite máximo WhatsApp (documentos)

async function ensureBucket() {
  try {
    const { data: list } = await supabase.storage.listBuckets();
    const exists = list?.some((b) => b.name === MEDIA_BUCKET);
    if (!exists) {
      await supabase.storage.createBucket(MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: MAX_FILE_SIZE,
      });
    }
  } catch (err: any) {
    console.warn("[UploadMedia] Error ensuring bucket:", err?.message);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireClientId(req);
    if (!session.ok) {
      return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
    }
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Storage indisponível" }, { status: 500 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return NextResponse.json({ success: false, error: "Nenhum arquivo enviado" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({
        success: false,
        error: `Arquivo de ${(file.size / 1024 / 1024).toFixed(1)}MB excede o limite de 100MB do WhatsApp.`,
      }, { status: 413 });
    }

    await ensureBucket();

    const safeFormat = resolveSafeUploadFormat(file.name, file.type);
    if (!safeFormat) {
      return NextResponse.json(
        { success: false, error: "Tipo de arquivo não permitido" },
        { status: 415 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const safeClientId = (session.clientId || "shared").replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${safeClientId}/kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${safeFormat.ext}`;

    const { error: uploadErr } = await supabase.storage.from(MEDIA_BUCKET).upload(fileName, buffer, {
      contentType: safeFormat.contentType,
      upsert: true,
    });

    if (uploadErr) {
      console.error("[UploadMedia] Storage upload error:", uploadErr.message);
      return NextResponse.json({ success: false, error: uploadErr.message }, { status: 500 });
    }

    const publicUrl = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(fileName).data.publicUrl;

    return NextResponse.json({
      success: true,
      url: publicUrl,
      fileName,
    });
  } catch (err: any) {
    console.error("[UploadMedia] Handler error:", err?.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
