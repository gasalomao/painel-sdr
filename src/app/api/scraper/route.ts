/**
 * /api/scraper — wrapper HTTP fino. Toda a lógica do scraper vive em
 * `lib/scraper-engine.ts` pra que o automation-worker possa chamar
 * a engine direto, sem fazer um fetch HTTP pra ele mesmo (que era frágil).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  startScraperRun,
  stopScraper,
  pauseScraper,
  resumeScraper,
  clearLeads,
  getLeads,
  sendLeadsBatch,
  attachSseClient,
  detachSseClient,
} from "@/lib/scraper-engine";
import { isSessionLiveStrict, SESSION_COOKIE, verifySession } from "@/lib/auth";
import { cookies } from "next/headers";

// --- GET: SSE Stream ---
// AUTH: precisa de sessão. Antes era PÚBLICO — qualquer um no mundo via stream
// de scraping ativo (multi-tenant leak total).
export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  if (!session?.clientId || !session.sessionId || !token || !(await isSessionLiveStrict(session.sessionId, token))) {
    return new Response("Não autenticado", { status: 401 });
  }
  let streamController: ReadableStreamDefaultController | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      attachSseClient(controller, session.clientId);
      closeTimer = setTimeout(() => {
        detachSseClient(controller);
        try { controller.close(); } catch {}
      }, 60_000);
    },
    cancel() {
      if (closeTimer) clearTimeout(closeTimer);
      if (streamController) detachSseClient(streamController);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// --- POST: Actions ---
export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  if (!session?.clientId || !session.sessionId || !token || !(await isSessionLiveStrict(session.sessionId, token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action } = body;

  switch (action) {
    case "start": {
      const r = startScraperRun({
        niches: body.niches,
        regions: body.regions,
        webhookUrl: body.webhookUrl,
        webhookEnabled: body.webhookEnabled,
        mode: body.mode,
        filterEmpty: body.filterEmpty,
        filterDuplicates: body.filterDuplicates,
        filterLandlines: body.filterLandlines,
        filterWithWebsite: body.filterWithWebsite === true,
        captureAllReviews: body.captureAllReviews === true,
        maxLeads: body.maxLeads,            // /captador também pode passar limite
        client_id: session.clientId,
        reviews_ai: body.reviews_ai,        // resumo automático pós-save (Busca)
      });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      if (r.alreadyRunning) {
        return NextResponse.json({ error: "O extrator já está rodando.", attached_automation: body.automation_id || null }, { status: 400 });
      }
      return NextResponse.json({ success: true, attached_automation: body.automation_id || null });
    }
    case "stop": {
      if (!stopScraper(session.clientId)) return NextResponse.json({ error: "Extrator indisponível." }, { status: 409 });
      return NextResponse.json({ success: true });
    }
    case "pause": {
      if (!pauseScraper(session.clientId)) return NextResponse.json({ error: "Extrator indisponível." }, { status: 409 });
      return NextResponse.json({ success: true });
    }
    case "resume": {
      if (!resumeScraper(session.clientId)) return NextResponse.json({ error: "Extrator indisponível." }, { status: 409 });
      return NextResponse.json({ success: true });
    }
    case "clear": {
      if (!clearLeads(session.clientId)) return NextResponse.json({ error: "Extrator indisponível." }, { status: 409 });
      return NextResponse.json({ success: true });
    }
    case "get_leads": {
      return NextResponse.json(getLeads(session.clientId));
    }
    case "send_batch": {
      const r = await sendLeadsBatch(body.webhookUrl, session.clientId);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, count: r.count });
    }
    default:
      return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  }
}
