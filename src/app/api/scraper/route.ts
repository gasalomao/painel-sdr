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
  getStatus,
  sendLeadsBatch,
  attachSseClient,
  detachSseClient,
} from "@/lib/scraper-engine";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { cookies } from "next/headers";

// --- GET: SSE Stream ---
export async function GET() {
  const stream = new ReadableStream({
    start(controller) {
      attachSseClient(controller);
    },
    cancel(controller) {
      detachSseClient(controller as unknown as ReadableStreamDefaultController);
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
  if (!session) {
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
        maxLeads: body.maxLeads,            // /captador também pode passar limite
        automation_id: body.automation_id,
        client_id: session.clientId,
      });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      if (r.alreadyRunning) {
        return NextResponse.json({ error: "O extrator já está rodando.", attached_automation: body.automation_id || null }, { status: 400 });
      }
      return NextResponse.json({ success: true, attached_automation: body.automation_id || null });
    }
    case "stop": {
      stopScraper();
      return NextResponse.json({ success: true });
    }
    case "pause": {
      pauseScraper();
      return NextResponse.json({ success: true });
    }
    case "resume": {
      resumeScraper();
      return NextResponse.json({ success: true });
    }
    case "clear": {
      clearLeads();
      return NextResponse.json({ success: true });
    }
    case "get_leads": {
      return NextResponse.json(getLeads());
    }
    case "send_batch": {
      const r = await sendLeadsBatch(body.webhookUrl);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 500 });
      return NextResponse.json({ success: true, count: r.count });
    }
    default:
      return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  }
}
