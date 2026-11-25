import { NextRequest, NextResponse } from "next/server";
import {
  extractFullLeadCrmDossier,
  extractLeadCrmSummary,
} from "@/lib/crm-lead-profile";
import { enrichCapturedLead } from "@/lib/scraper-lead-enrichment";
import { requireClientId } from "@/lib/tenant";
import { checkTenantRateLimit } from "@/lib/saas-limits";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

const ENRICH_COOLDOWN_MS = 12_000;
const recentEnrichRuns = new Map<string, number>();

function extractCityUfFromLead(lead: Record<string, unknown>): {
  cidade: string;
  uf: string;
  cep: string;
} {
  const ac =
    lead.address_components && typeof lead.address_components === "object"
      ? (lead.address_components as Record<string, unknown>)
      : {};
  let cidade = typeof ac.cidade === "string" ? ac.cidade.trim() : typeof ac.city === "string" ? ac.city.trim() : "";
  let uf = typeof ac.estado === "string" ? ac.estado.trim() : typeof ac.uf === "string" ? ac.uf.trim() : "";
  let cep = typeof lead.cep === "string" ? lead.cep.trim() : typeof ac.cep === "string" ? ac.cep.trim() : "";

  const endereco = typeof lead.endereco === "string" ? lead.endereco.trim() : "";
  if (endereco) {
    if (!cep) {
      const cepMatch = endereco.match(/\b(\d{5}-?\d{3})\b/);
      if (cepMatch) cep = cepMatch[1];
    }
    const cityStateMatch = endereco.match(/,\s*([^,-]+?)\s*-\s*([A-Z]{2})\b/);
    if (cityStateMatch) {
      if (!cidade) cidade = cityStateMatch[1].trim();
      if (!uf) uf = cityStateMatch[2].trim();
    }
  }
  return { cidade, uf, cep };
}

/**
 * POST /api/leads/[id]/enrich
 * Executa auditoria gratuita sob demanda (saúde técnica do site, pixels, sistemas,
 * RDAP Registro.br e Receita Federal QSA) para enriquecer leads antigos ou manuais.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "ID do lead é obrigatório" }, { status: 400 });
    }

    if (!auth.isAdmin) {
      const tenantRl = checkTenantRateLimit(`lead_enrich_tenant:${auth.clientId}`, 10, 60_000);
      if (!tenantRl.allowed) {
        return NextResponse.json(
          { error: `Limite de auditorias por minuto atingido. Aguarde ${tenantRl.retryAfterSec ?? 1}s.` },
          { status: 429 },
        );
      }
    }

    const rateKey = `${auth.clientId}:${id}`;
    const now = Date.now();
    const lastRun = recentEnrichRuns.get(rateKey) ?? 0;
    if (now - lastRun < ENRICH_COOLDOWN_MS) {
      return NextResponse.json(
        { error: "Aguarde alguns segundos antes de auditar este lead novamente." },
        { status: 429 },
      );
    }
    recentEnrichRuns.set(rateKey, now);
    if (recentEnrichRuns.size > 500) {
      const oldestKey = recentEnrichRuns.keys().next().value;
      if (oldestKey) recentEnrichRuns.delete(oldestKey);
    }

    const { data: lead, error: readErr } = await supabaseAdmin
      .from("leads_extraidos")
      .select("*")
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    if (!lead) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    const leadRec = lead as Record<string, unknown>;
    const bd =
      leadRec.business_details &&
      typeof leadRec.business_details === "object" &&
      !Array.isArray(leadRec.business_details)
        ? (leadRec.business_details as Record<string, unknown>)
        : {};
    const { cidade, uf, cep } = extractCityUfFromLead(leadRec);
    const services = Array.isArray(bd.services)
      ? (bd.services as string[])
      : Array.isArray(bd.servicos)
        ? (bd.servicos as string[])
        : undefined;
    const reviews = Array.isArray(leadRec.reviews_detalhes)
      ? (leadRec.reviews_detalhes as Array<{ texto?: string; respostaDono?: string }>)
      : undefined;

    const result = await enrichCapturedLead({
      tenantId: auth.clientId,
      name: String(leadRec.nome_negocio || ""),
      phone: String(leadRec.telefone || leadRec.remoteJid || ""),
      website: typeof leadRec.website === "string" ? leadRec.website : undefined,
      instagram: typeof leadRec.instagram === "string" ? leadRec.instagram : undefined,
      categories: String(leadRec.categoria || leadRec.ramo_negocio || ""),
      fullAddress: typeof leadRec.endereco === "string" ? leadRec.endereco : undefined,
      cep,
      cidade,
      uf,
      averageRating: leadRec.avaliacao != null ? String(leadRec.avaliacao) : undefined,
      reviewCount: leadRec.reviews != null ? String(leadRec.reviews) : undefined,
      claimed: typeof leadRec.claimed === "boolean" ? leadRec.claimed : undefined,
      ownerName: typeof leadRec.owner_name === "string" ? leadRec.owner_name : undefined,
      services,
      reviews,
      options: {
        auditSiteHealth: true,
        enrichCnpj: true,
        prioritizePartnerPhone: false,
        validateWhatsApp: false,
        huntPartnerDirectPhone: false,
      },
    });

    const nextBd: Record<string, unknown> = {
      ...bd,
      enrichment: result.enrichment,
    };

    const patch: Record<string, unknown> = {
      business_details: nextBd,
      updated_at: new Date().toISOString(),
    };
    if (!leadRec.owner_name && result.enrichment.socioDecisor) {
      patch.owner_name = result.enrichment.socioDecisor;
    }
    if (!leadRec.email && result.enrichment.emailValidado) {
      patch.email = result.enrichment.emailValidado;
    }

    let updateRes = await supabaseAdmin
      .from("leads_extraidos")
      .update(patch)
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .select("*")
      .maybeSingle();

    if (updateRes.error && /column .* does not exist|PGRST204/i.test(String(updateRes.error.message || updateRes.error.code || ""))) {
      const minimalPatch = {
        business_details: nextBd,
        updated_at: patch.updated_at,
      };
      updateRes = await supabaseAdmin
        .from("leads_extraidos")
        .update(minimalPatch)
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .select("*")
        .maybeSingle();
    }

    if (updateRes.error) {
      return NextResponse.json({ error: updateRes.error.message }, { status: 500 });
    }
    if (!updateRes.data) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    const updatedRec = updateRes.data as Record<string, unknown>;
    const crm_summary = extractLeadCrmSummary(updatedRec);
    const crm_dossier = extractFullLeadCrmDossier(updatedRec);

    return NextResponse.json({
      success: true,
      lead: {
        ...updatedRec,
        crm_summary,
      },
      crm_summary,
      crm_dossier,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Falha ao auditar lead" },
      { status: 500 },
    );
  }
}

