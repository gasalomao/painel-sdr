import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const tags = new Set<string>();
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabaseAdmin.from("contacts")
        .select("id,tags")
        .eq("client_id", auth.clientId)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error || !Array.isArray(data)) throw error ?? new Error("Consulta de tags indisponível");

      for (const contact of data) {
        if (!Array.isArray(contact.tags)) continue;
        for (const tag of contact.tags) {
          if (typeof tag === "string" && tag.trim()) tags.add(tag.trim());
        }
      }
      if (data.length < pageSize) break;
    }

    return NextResponse.json({ tags: [...tags].sort((a, b) => a.localeCompare(b, "pt-BR")) },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Não foi possível consultar as tags." },
      { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
