import { NextRequest, NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";

export const dynamic = "force-dynamic";

/**
 * Proxy por instância na Evolution API v2.
 *
 *  GET    /api/whatsapp/proxy?instance=sdr        → lê o proxy atual
 *  POST   /api/whatsapp/proxy                     → aplica/atualiza o proxy
 *    body: { instanceName, host, port, protocol, username?, password? }
 *  DELETE /api/whatsapp/proxy?instance=sdr        → remove o proxy
 */

export async function GET(req: NextRequest) {
  try {
    const instance = req.nextUrl.searchParams.get("instance");
    if (!instance) return NextResponse.json({ success: false, error: "instance é obrigatória" }, { status: 400 });
    const proxy = await evolution.findProxy(instance);
    return NextResponse.json({ success: true, proxy });
  } catch (err: any) {
    // Se a Evolution retornar 404/não configurado, é "sem proxy" — normal.
    const msg = err?.message || String(err);
    if (/not found|404|n[aã]o configurado/i.test(msg)) {
      return NextResponse.json({ success: true, proxy: { enabled: false } });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { instanceName, host, port, protocol, username, password } = await req.json();
    if (!instanceName) return NextResponse.json({ success: false, error: "instanceName é obrigatório" }, { status: 400 });
    if (!host || !port) return NextResponse.json({ success: false, error: "host e port são obrigatórios" }, { status: 400 });

    const validProtocols = ["http", "https", "socks4", "socks5"];
    const proto = validProtocols.includes(protocol) ? protocol : "http";

    const result = await evolution.setProxy(instanceName, {
      enabled: true,
      host: String(host).trim(),
      port: String(port).trim(),
      protocol: proto as any,
      username: username ? String(username) : "",
      password: password ? String(password) : "",
    });
    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const instance = req.nextUrl.searchParams.get("instance");
    if (!instance) return NextResponse.json({ success: false, error: "instance é obrigatória" }, { status: 400 });
    const result = await evolution.removeProxy(instance);
    return NextResponse.json({ success: true, result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || String(err) }, { status: 500 });
  }
}
