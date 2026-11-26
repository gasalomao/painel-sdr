import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import {
  cancelScheduledPreviewDelivery,
  enqueueScheduledPreviewDelivery,
  listScheduledPreviewDeliveries,
  tickScheduledPreviewDeliveries,
  type NaturalDeliverySlot,
} from "@/lib/preview-delivery-queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const deliveries = await listScheduledPreviewDeliveries(auth.clientId, status);
  return NextResponse.json({ ok: true, deliveries });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Payload JSON inválido" }, { status: 400 });
  }

  const action = String(body.action || "enqueue");
  if (action === "cancel") {
    const id = String(body.id || "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "id é obrigatório" }, { status: 400 });
    const res = await cancelScheduledPreviewDelivery(auth.clientId, id);
    return NextResponse.json({ ok: res.ok });
  }

  const remoteJid = String(body.remote_jid || "").trim();
  const instanceName = String(body.instance_name || "").trim();
  const previewUrl = String(body.preview_url || "").trim();
  const slot = String(body.delivery_slot || "now") as NaturalDeliverySlot;

  const res = await enqueueScheduledPreviewDelivery({
    clientId: auth.clientId,
    contactId: body.contact_id ? String(body.contact_id) : null,
    campaignId: body.campaign_id ? String(body.campaign_id) : null,
    remoteJid,
    instanceName,
    companyName: body.company_name ? String(body.company_name) : null,
    previewUrl,
    messageText: body.message_text ? String(body.message_text) : null,
    deliverySlot: slot,
    scheduledFor: body.scheduled_for ? String(body.scheduled_for) : null,
    createdBy: auth.clientId,
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  }

  if (slot === "now") {
    await tickScheduledPreviewDeliveries().catch(() => null);
  }

  return NextResponse.json({ ok: true, delivery: res.delivery });
}
