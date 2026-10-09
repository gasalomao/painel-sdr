/**
 * API Route para activity logs em tempo real
 * Suporta tanto POST (salvar) quanto GET/EventSource (stream)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertWebsiteOrigin } from "@/lib/sites/security";
import type { ActivityEvent } from "@/lib/sites/activity-logger";

/**
 * POST - Salva novos eventos de atividade
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  assertWebsiteOrigin(request);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const { runId } = params;
  const body = await request.json();
  const { events } = body as { events: ActivityEvent[] };

  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "Events array required" }, { status: 400 });
  }

  // Verifica se o run pertence ao usuário
  const { data: run, error: runError } = await supabase
    .from("website_runs")
    .select("id, project_id, website_projects!inner(client_id)")
    .eq("id", runId)
    .single();

  if (runError || !run) {
    return NextResponse.json({ error: "Run não encontrado" }, { status: 404 });
  }

  // @ts-ignore - Supabase types
  if (run.website_projects.client_id !== user.id) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  // Insere activities
  const activities = events.map((event) => ({
    run_id: runId,
    type: event.type,
    message: event.message,
    status: event.status || null,
    details: event.details || null,
    duration_ms: event.duration || null,
    created_at: new Date(event.timestamp).toISOString(),
  }));

  const { error: insertError } = await supabase
    .from("website_run_activities")
    .insert(activities);

  if (insertError) {
    console.error("Error inserting activities:", insertError);
    return NextResponse.json({ error: "Falha ao salvar atividades" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

/**
 * GET - Lista atividades ou stream em tempo real
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  assertWebsiteOrigin(request);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const { runId } = params;
  const { searchParams } = new URL(request.url);
  const stream = searchParams.get("stream") === "true";

  // Verifica se o run pertence ao usuário
  const { data: run, error: runError } = await supabase
    .from("website_runs")
    .select("id, project_id, website_projects!inner(client_id)")
    .eq("id", runId)
    .single();

  if (runError || !run) {
    return NextResponse.json({ error: "Run não encontrado" }, { status: 404 });
  }

  // @ts-ignore - Supabase types
  if (run.website_projects.client_id !== user.id) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  }

  // Stream via Server-Sent Events
  if (stream) {
    return streamActivities(runId, supabase);
  }

  // Retorna todas as atividades
  const { data: activities, error } = await supabase
    .from("website_run_activities")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching activities:", error);
    return NextResponse.json({ error: "Falha ao carregar atividades" }, { status: 500 });
  }

  return NextResponse.json({ activities: activities || [] });
}

/**
 * Stream de atividades em tempo real via Server-Sent Events
 */
function streamActivities(runId: string, supabase: any): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Envia atividades existentes
      const { data: existingActivities } = await supabase
        .from("website_run_activities")
        .select("*")
        .eq("run_id", runId)
        .order("created_at", { ascending: true });

      if (existingActivities) {
        for (const activity of existingActivities) {
          const event = formatSSE(activity);
          controller.enqueue(encoder.encode(event));
        }
      }

      // Subscreve a novos eventos via Realtime
      const channel = supabase
        .channel(`run-activities:${runId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "website_run_activities",
            filter: `run_id=eq.${runId}`,
          },
          (payload: any) => {
            const event = formatSSE(payload.new);
            controller.enqueue(encoder.encode(event));
          }
        )
        .subscribe();

      // Cleanup ao fechar conexão
      return () => {
        channel.unsubscribe();
      };
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Formata evento no padrão Server-Sent Events
 */
function formatSSE(activity: any): string {
  const data = {
    id: activity.id,
    type: activity.type,
    message: activity.message,
    status: activity.status,
    details: activity.details,
    duration: activity.duration_ms,
    timestamp: new Date(activity.created_at).getTime(),
  };

  return `data: ${JSON.stringify(data)}\n\n`;
}
