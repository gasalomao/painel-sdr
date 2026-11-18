import { NextRequest, NextResponse } from "next/server";
import { extractLeadCrmSummary } from "@/lib/crm-lead-profile";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 15;
const MAX_PAGE_SIZE = 100;
const KANBAN_LIMIT = 1000;

export const VALID_LEAD_SIGNALS = [
  "all",
  "partner_direct",
  "site_opportunity",
  "paid_traffic",
  "high_icp",
] as const;
export type LeadSignalFilter = (typeof VALID_LEAD_SIGNALS)[number];

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
  "owner_name",
  "year_established",
  "claimed",
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

function parseSignalFilter(raw: string | null): LeadSignalFilter {
  const clean = (raw || "all").trim().toLowerCase();
  return (VALID_LEAD_SIGNALS as readonly string[]).includes(clean)
    ? (clean as LeadSignalFilter)
    : "all";
}

function projectLightweightLeadRow(rawRow: Record<string, unknown>): Record<string, unknown> {
  const crm_summary = extractLeadCrmSummary(rawRow);
  const bd = rawRow.business_details;
  const lembreteTexto =
    bd && typeof bd === "object" && !Array.isArray(bd)
      ? (bd as Record<string, unknown>).lembrete_texto
      : undefined;

  return {
    ...rawRow,
    business_details:
      typeof lembreteTexto === "string" && lembreteTexto.length > 0
        ? { lembrete_texto: lembreteTexto }
        : null,
    crm_summary,
  };
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
      10,
    );
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize))
      : DEFAULT_PAGE_SIZE;

    const safeSearch = sanitizePostgrestIlikeTerm(searchParams.get("search") || "");
    const digitsSearch = safeSearch.replace(/\D/g, "");
    const category = (searchParams.get("category") || "all").trim();
    const disparo = (searchParams.get("disparo") || "all").trim();
    const signal = parseSignalFilter(searchParams.get("signal"));

    const buildLeadsQuery = (columnsToSelect: string, legacyFallback = false) => {
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
        if (legacyFallback) {
          query = query.or(
            `nome_negocio.ilike.%${safeSearch}%,ramo_negocio.ilike.%${safeSearch}%,telefone.ilike.%${safeSearch}%`,
          );
        } else {
          const clauses = [
            `nome_negocio.ilike.%${safeSearch}%`,
            `ramo_negocio.ilike.%${safeSearch}%`,
            `telefone.ilike.%${safeSearch}%`,
            `endereco.ilike.%${safeSearch}%`,
            `owner_name.ilike.%${safeSearch}%`,
            `email.ilike.%${safeSearch}%`,
            `business_details->enrichment->>socioDecisor.ilike.%${safeSearch}%`,
            `business_details->crm_overrides->>socioDecisor.ilike.%${safeSearch}%`,
          ];
          if (digitsSearch.length >= 6) {
            clauses.push(`telefone.ilike.%${digitsSearch}%`);
            clauses.push(`business_details->enrichment->>cnpj.ilike.%${digitsSearch}%`);
            clauses.push(`business_details->crm_overrides->>cnpj.ilike.%${digitsSearch}%`);
          }
          query = query.or(clauses.join(","));
        }
      }

      if (category && category !== "all") {
        query = query.eq("ramo_negocio", category);
      }

      if (disparo === "sent") {
        query = query.eq("primeiro_contato_source", "disparo");
      } else if (disparo === "pending") {
        query = query.or("primeiro_contato_source.is.null,primeiro_contato_source.neq.disparo");
      }

      if (!legacyFallback && signal !== "all") {
        if (signal === "partner_direct") {
          query = query.or(
            "business_details->enrichment->>whatsappChannelType.eq.socio_direto,business_details->enrichment->>whatsappChannelType.eq.provavel_socio,business_details->crm_overrides->>canalWhatsapp.eq.socio_direto,business_details->crm_overrides->>canalWhatsapp.eq.provavel_socio",
          );
        } else if (signal === "site_opportunity") {
          query = query.or(
            "website.is.null,website.eq.,business_details->enrichment->>siteHealth.eq.no_site,business_details->enrichment->>siteHealth.eq.broken_site,business_details->enrichment->>siteHealth.eq.weak_site",
          );
        } else if (signal === "paid_traffic") {
          query = query.eq("business_details->enrichment->>hasPaidTrafficTag", "true");
        } else if (signal === "high_icp") {
          query = query.or("icp_score.gte.70,business_details->enrichment->qualificationScore.gte.70");
        }
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
      buildLeadsQuery(LEAD_LIST_COLUMNS, false),
    ]);

    let leadsRes = initialLeadsRes;
    if (leadsRes?.error) {
      leadsRes = await buildLeadsQuery("*", true);
    }

    if (leadsRes?.error) {
      return NextResponse.json({ error: leadsRes.error.message }, { status: 500 });
    }

    const sentJids = Array.isArray(sentTargetsRes?.data)
      ? (sentTargetsRes.data as { remote_jid?: string }[])
          .map((t) => t.remote_jid)
          .filter((jid): jid is string => typeof jid === "string" && jid.length > 0)
      : [];

    const rawLeads = Array.isArray(leadsRes?.data)
      ? (leadsRes.data as unknown as Record<string, unknown>[])
      : [];
    const projectedLeads = rawLeads.map(projectLightweightLeadRow);

    return NextResponse.json({
      leads: projectedLeads,
      totalCount: leadsRes?.count ?? 0,
      sentJids,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao carregar leads" },
      { status: 500 },
    );
  }
}
