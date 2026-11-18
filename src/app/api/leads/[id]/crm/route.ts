import { NextRequest, NextResponse } from "next/server";
import { parseISO } from "date-fns/parseISO";
import {
  extractFullLeadCrmDossier,
  extractLeadCrmSummary,
  validateAndNormalizeCrmProfilePatch,
} from "@/lib/crm-lead-profile";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { readPhotoCache } from "@/lib/whatsapp-photos";

export const dynamic = "force-dynamic";

function isMissingColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "PGRST204" ||
    /column .* does not exist/i.test(String(err.message || "")) ||
    /Could not find the .* column/i.test(String(err.message || ""))
  );
}

/**
 * GET /api/leads/[id]/crm
 * Retorna dados detalhados do lead + dossiê enriquecido para a Ficha / CRM
 */
export async function GET(
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

    const { data: lead, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("*")
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!lead) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    // Abrir a ficha só lê cache; chamadas ao WhatsApp exigem ação explícita.
    let profilePicUrl: string | null = null;
    const jid = getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone);
    if (jid) profilePicUrl = (await readPhotoCache(auth.clientId, [jid])).get(jid)?.url ?? null;

    const lembreteTexto = lead.next_follow_up
      ? (lead.business_details?.lembrete_texto ?? lead.observacoes ?? "")
      : "";

    const crm_summary = extractLeadCrmSummary(lead as Record<string, unknown>);
    const crm_dossier = extractFullLeadCrmDossier(lead as Record<string, unknown>);

    return NextResponse.json({
      lead: {
        ...lead,
        lembrete_texto: lembreteTexto,
        crm_summary,
      },
      profilePicUrl,
      lembrete_texto: lembreteTexto,
      crm_summary,
      crm_dossier,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro interno" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/leads/[id]/crm
 * Atualiza observações, lembrete de retorno ou dados enriquecidos do perfil (`crm_profile`) de forma segura.
 */
export async function PATCH(
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

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Corpo JSON inválido" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (
      !["observacoes", "next_follow_up", "lembrete_texto", "crm_profile"].some(
        (key) => key in input,
      )
    ) {
      return NextResponse.json({ error: "Nenhum campo válido informado" }, { status: 400 });
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    for (const [key, maxLength] of [
      ["observacoes", 20000],
      ["lembrete_texto", 1000],
    ] as const) {
      const value = input[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.length > maxLength)
      ) {
        return NextResponse.json(
          { error: `Campo ${key} inválido (máximo ${maxLength} caracteres)` },
          { status: 400 },
        );
      }
    }

    if ("observacoes" in input) {
      patch.observacoes =
        typeof input.observacoes === "string" ? input.observacoes.trim() : null;
    }

    if ("next_follow_up" in input) {
      const value = input.next_follow_up;
      if (value === null) {
        patch.next_follow_up = null;
      } else if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) ||
        !Number.isFinite(Date.parse(value)) ||
        !Number.isFinite(parseISO(value).getTime())
      ) {
        return NextResponse.json(
          { error: "Formato de data inválido para next_follow_up" },
          { status: 400 },
        );
      } else {
        patch.next_follow_up = new Date(value).toISOString();
      }
    }

    let validatedProfile: ReturnType<typeof validateAndNormalizeCrmProfilePatch> | null = null;
    if ("crm_profile" in input) {
      validatedProfile = validateAndNormalizeCrmProfilePatch(input.crm_profile);
      if (!validatedProfile.ok) {
        return NextResponse.json({ error: validatedProfile.error }, { status: 400 });
      }
    }

    const needsCurrentRead =
      "lembrete_texto" in input ||
      ("next_follow_up" in input && input.next_follow_up !== null) ||
      validatedProfile !== null;

    if (needsCurrentRead) {
      const cleanLembrete =
        typeof input.lembrete_texto === "string" ? input.lembrete_texto.trim() : null;
      if ("lembrete_texto" in input && input.next_follow_up !== null && !cleanLembrete) {
        return NextResponse.json({ error: "Descreva o lembrete" }, { status: 400 });
      }

      const { data: currentLead, error: readError } = await supabaseAdmin
        .from("leads_extraidos")
        .select("business_details, observacoes, next_follow_up")
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .maybeSingle();
      if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
      if (!currentLead) {
        return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
      }

      const currentBd =
        currentLead.business_details &&
        typeof currentLead.business_details === "object" &&
        !Array.isArray(currentLead.business_details)
          ? (currentLead.business_details as Record<string, unknown>)
          : {};

      let nextBd: Record<string, unknown> | null = null;

      if ("lembrete_texto" in input || ("next_follow_up" in input && input.next_follow_up !== null)) {
        const effectiveDue =
          "next_follow_up" in input ? patch.next_follow_up : currentLead.next_follow_up;
        const effectiveNotes =
          "observacoes" in input ? patch.observacoes : currentLead.observacoes;
        const effectiveText =
          "lembrete_texto" in input
            ? cleanLembrete
            : ((currentBd.lembrete_texto as string | undefined) ??
              (currentLead.next_follow_up ? effectiveNotes : null));
        if (
          input.next_follow_up !== null &&
          (!effectiveDue || typeof effectiveText !== "string" || !effectiveText.trim())
        ) {
          return NextResponse.json(
            { error: "Descreva o lembrete e selecione o vencimento" },
            { status: 400 },
          );
        }
        if ("lembrete_texto" in input) {
          nextBd = {
            ...(nextBd ?? currentBd),
            lembrete_texto: cleanLembrete,
          };
        }
      }

      if (validatedProfile && validatedProfile.ok) {
        for (const [col, val] of Object.entries(validatedProfile.topLevelColumns)) {
          patch[col] = val;
        }
        const existingOverrides =
          currentBd.crm_overrides &&
          typeof currentBd.crm_overrides === "object" &&
          !Array.isArray(currentBd.crm_overrides)
            ? (currentBd.crm_overrides as Record<string, unknown>)
            : {};
        nextBd = {
          ...(nextBd ?? currentBd),
          crm_overrides: {
            ...existingOverrides,
            ...validatedProfile.overridesPatch,
          },
        };
      }

      if (nextBd !== null) {
        patch.business_details = nextBd;
      }
    }

    const selectCols = validatedProfile
      ? "*"
      : "id, client_id, observacoes, next_follow_up, business_details, updated_at";

    let updateRes = await supabaseAdmin
      .from("leads_extraidos")
      .update(patch)
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .select(selectCols)
      .maybeSingle();

    if (updateRes.error && validatedProfile && isMissingColumnError(updateRes.error)) {
      const fallbackPatch = { ...patch };
      delete fallbackPatch.owner_name;
      delete fallbackPatch.email;
      updateRes = await supabaseAdmin
        .from("leads_extraidos")
        .update(fallbackPatch)
        .eq("id", id)
        .eq("client_id", auth.clientId)
        .select(selectCols)
        .maybeSingle();
    }

    const { data: updated, error } = updateRes;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json(
        { error: "Lead não encontrado ou não autorizado" },
        { status: 404 },
      );
    }

    const updatedRec = updated as unknown as Record<string, unknown>;
    const updatedBd =
      updatedRec.business_details && typeof updatedRec.business_details === "object"
        ? (updatedRec.business_details as Record<string, unknown>)
        : null;
    const lembreteTexto = updatedRec.next_follow_up
      ? ((updatedBd?.lembrete_texto as string | undefined) ??
        (updatedRec.observacoes as string | null | undefined) ??
        null)
      : null;

    if (validatedProfile) {
      const crm_summary = extractLeadCrmSummary(updatedRec);
      const crm_dossier = extractFullLeadCrmDossier(updatedRec);
      return NextResponse.json({
        success: true,
        lead: {
          ...updatedRec,
          lembrete_texto: lembreteTexto,
          crm_summary,
        },
        crm_summary,
        crm_dossier,
      });
    }

    return NextResponse.json({
      success: true,
      lead: {
        ...updatedRec,
        lembrete_texto: lembreteTexto,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro interno" },
      { status: 500 },
    );
  }
}
