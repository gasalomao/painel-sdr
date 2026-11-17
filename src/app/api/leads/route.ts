import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 100;
const KANBAN_LIMIT = 1000;

const LEAD_LIST_COLUMNS = [
  "id",
  '"remoteJid"',
  "nome_negocio",
  "telefone",
  "email",
  "ramo_negocio",
  "categoria",
  "endereco",
  "avaliacao",
  "rating",
  "reviews",
  "website",
  "instagram",
  "facebook",
  "maps_url",
  "status",
  "instance_name",
  "next_follow_up",
  "observacoes",
  "business_details",
  "justificativa_ia",
  "resumo_ia",
  "ia_last_analyzed_at",
  "created_at",
  "primeiro_contato_source",
  "primeiro_contato_at",
  "intelligence",
  "intelligence_at",
  "icp_score",
  "lead_type",
].join(", ");

function sanitizePostgrestIlikeTerm(raw: string): string {
  return raw
    .replace(/[(),]/g, " ")
    .replace(/[\\%_]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const db = supabaseAdmin;
    if (!db) {
      return NextResponse.json({ error: "DB indisponível" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const rawView = (searchParams.get("view") || "list").trim().toLowerCase();
    const view: "list" | "kanban" | "export" =
      rawView === "kanban" || rawView === "export" ? rawView : "list";

    if (view === "export") {
      const { data, error } = await db
        .from("leads_extraidos")
        .select("*")
        .eq("client_id", auth.clientId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ leads: data || [] });
    }

    const rawPage = Number.parseInt(searchParams.get("page") || "0", 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;

    const rawPageSize = Number.parseInt(
      searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE),
      10
    );
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize))
      : DEFAULT_PAGE_SIZE;

    const safeSearch = sanitizePostgrestIlikeTerm(searchParams.get("search") || "");
    const category = (searchParams.get("category") || "all").trim();
    const disparo = (searchParams.get("disparo") || "all").trim();

    const buildLeadsQuery = (columnsToSelect: string) => {
      let query = db
        .from("leads_extraidos")
        .select(columnsToSelect, { count: "exact" });

      if (view === "kanban") {
        query = query.order("updated_at", { ascending: false, nullsFirst: false });
      }

      query = query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .eq("client_id", auth.clientId);

      if (safeSearch) {
        query = query.or(
          `nome_negocio.ilike.%${safeSearch}%,ramo_negocio.ilike.%${safeSearch}%,telefone.ilike.%${safeSearch}%`
        );
      }

      if (category && category !== "all") {
        query = query.eq("ramo_negocio", category);
      }

      if (disparo === "sent") {
        query = query.eq("primeiro_contato_source", "disparo");
      } else if (disparo === "pending") {
        query = query.or("primeiro_contato_source.is.null,primeiro_contato_source.neq.disparo");
      }

      if (view === "list") {
        query = query.range(page * pageSize, (page + 1) * pageSize - 1);
      } else {
        query = query.limit(KANBAN_LIMIT);
      }

      return query;
    };

    const sentTargetsPromise = db
      .from("campaign_targets")
      .select("remote_jid")
      .eq("status", "sent")
      .eq("client_id", auth.clientId);

    const [sentTargetsRes, initialLeadsRes] = await Promise.all([
      sentTargetsPromise,
      buildLeadsQuery(LEAD_LIST_COLUMNS),
    ]);

    let leadsRes = initialLeadsRes;
    if (leadsRes?.error) {
      leadsRes = await buildLeadsQuery("*");
    }

    if (leadsRes?.error) {
      return NextResponse.json({ error: leadsRes.error.message }, { status: 500 });
    }

    const sentJids = Array.isArray(sentTargetsRes?.data)
      ? (sentTargetsRes.data as { remote_jid?: string }[])
          .map((t) => t.remote_jid)
          .filter((jid): jid is string => typeof jid === "string" && jid.length > 0)
      : [];

    return NextResponse.json({
      leads: leadsRes?.data || [],
      totalCount: leadsRes?.count ?? 0,
      sentJids,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao carregar leads" },
      { status: 500 }
    );
  }
}

