import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { verifySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MEDIA_BUCKET = "chat-media";

async function ensureBucket() {
  try {
    const { data: list } = await supabase.storage.listBuckets();
    const exists = list?.some((b) => b.name === MEDIA_BUCKET);
    if (!exists) {
      await supabase.storage.createBucket(MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: 52428800, // 50MB
      });
    }
  } catch (err: any) {
    console.warn("[UploadMedia] Error ensuring bucket:", err?.message);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await verifySession(req);
    if (!session) {
      return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return NextResponse.json({ success: false, error: "Nenhum arquivo de imagem enviado" }, { status: 400 });
    }

    await ensureBucket();

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const ext = file.name.split(".").pop() || "jpg";
    const fileName = `kb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;

    const { error: uploadErr } = await supabase.storage.from(MEDIA_BUCKET).upload(fileName, buffer, {
      contentType: file.type || "image/jpeg",
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
