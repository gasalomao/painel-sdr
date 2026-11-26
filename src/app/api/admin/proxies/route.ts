import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import {
  auditProxyPoolGeoAsn,
  getAdminProxyPoolSnapshot,
  importProxyPoolBatch,
  manageProxyBlacklist,
  rotateSingleInstanceProxy,
  saveProxyPoolSettings,
  syncRotatedProxiesBatch,
  testAvailablePoolProxies,
  type ProxyProtocol,
} from "@/lib/proxy-pool";

export const dynamic = "force-dynamic";

const MAX_TXT_BYTES = 2 * 1024 * 1024; // 2 MB

async function requireStrictAdmin(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return { ok: false as const, response: ctx.response };
  if (!ctx.isAdmin || ctx.impersonating) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, error: "Apenas o administrador principal pode gerenciar o pool de proxies." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, ctx };
}

/**
 * GET /api/admin/proxies
 * Retorna estatísticas, lista mascarada (sem senhas), Lista Negra, instâncias em fallback VPS
 * e histórico de lotes importados. Restrito exclusivamente ao Admin.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireStrictAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const snapshot = await getAdminProxyPoolSnapshot();
    return NextResponse.json({ success: true, ...snapshot });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/admin/proxies
 * Aceita JSON (`{ action, ... }`) ou `multipart/form-data` com arquivo `.txt` de proxies Webshare.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireStrictAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const contentType = req.headers.get("content-type") || "";
    let action = "";
    let rawText = "";
    let protocol: ProxyProtocol | undefined;
    let clearUsedBlacklist = false;
    let applyToInstances = true;
    let bodyJson: Record<string, unknown> = {};

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      action = String(formData.get("action") || "import_txt").trim();
      const protoVal = String(formData.get("protocol") || "").trim().toLowerCase();
      if (protoVal === "http" || protoVal === "https" || protoVal === "socks4" || protoVal === "socks5") {
        protocol = protoVal;
      }
      clearUsedBlacklist = String(formData.get("clearUsedBlacklist") || "false") === "true";
      applyToInstances = String(formData.get("applyToInstances") || "true") !== "false";

      const file = formData.get("file");
      const textField = formData.get("rawText");
      if (file && typeof (file as File).text === "function") {
        if ((file as File).size > MAX_TXT_BYTES) {
          return NextResponse.json(
            { success: false, error: "Arquivo .txt excede o limite de 2 MB." },
            { status: 400 },
          );
        }
        rawText = await (file as File).text();
      } else if (typeof textField === "string") {
        rawText = textField;
      }
    } else {
      const parsed = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        return NextResponse.json({ success: false, error: "Payload inválido" }, { status: 400 });
      }
      bodyJson = parsed;
      action = String(parsed.action || "").trim();
      if (typeof parsed.rawText === "string") rawText = parsed.rawText;
      const protoVal = String(parsed.protocol || "").trim().toLowerCase();
      if (protoVal === "http" || protoVal === "https" || protoVal === "socks4" || protoVal === "socks5") {
        protocol = protoVal;
      }
      clearUsedBlacklist = Boolean(parsed.clearUsedBlacklist);
      applyToInstances = parsed.applyToInstances !== false;
    }

    if (Buffer.byteLength(rawText, "utf8") > MAX_TXT_BYTES) {
      return NextResponse.json(
        { success: false, error: "Lista excede o limite de 2 MB." },
        { status: 400 },
      );
    }

    switch (action) {
      case "import_txt": {
        if (!rawText.trim()) {
          return NextResponse.json(
            { success: false, error: "Anexe um arquivo .txt ou cole a lista de proxies." },
            { status: 400 },
          );
        }
        const result = await importProxyPoolBatch({
          rawText,
          protocol,
          uploadedBy: auth.ctx.clientId,
          clearUsedBlacklist,
          applyToInstances,
        });
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, importResult: result, ...snapshot });
      }

      case "sync_all": {
        const syncRes = await syncRotatedProxiesBatch();
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, syncResult: syncRes, ...snapshot });
      }

      case "test_available": {
        const testRes = await testAvailablePoolProxies({
          limit: typeof bodyJson.limit === "number" ? bodyJson.limit : 120,
        });
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, testResult: testRes, ...snapshot });
      }

      case "audit_geo_asn": {
        const auditResult = await auditProxyPoolGeoAsn({
          limit: typeof bodyJson.limit === "number" ? bodyJson.limit : 40,
        });
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, auditResult, ...snapshot });
      }

      case "rotate_instance": {
        const instanceName = typeof bodyJson.instanceName === "string" ? bodyJson.instanceName.trim() : "";
        if (!instanceName) {
          return NextResponse.json({ success: false, error: "instanceName obrigatório" }, { status: 400 });
        }
        const rotateRes = await rotateSingleInstanceProxy(instanceName, null);
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, rotateResult: rotateRes, ...snapshot });
      }

      case "unblacklist":
      case "clear_used":
      case "clear_failed":
      case "clear_false_428":
      case "clear_all": {
        const proxyId = typeof bodyJson.proxyId === "string" ? bodyJson.proxyId.trim() : undefined;
        const blAction = action === "unblacklist" ? "unblacklist_id" : action;
        const blRes = await manageProxyBlacklist({ action: blAction, proxyId });
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, blacklistResult: blRes, ...snapshot });
      }

      case "update_settings": {
        const updatedSettings = await saveProxyPoolSettings({
          defaultProtocol: protocol,
          warmupReserveCount:
            bodyJson.warmupReserveCount !== undefined ? Number(bodyJson.warmupReserveCount) : undefined,
          strikeThreshold:
            bodyJson.strikeThreshold !== undefined ? Number(bodyJson.strikeThreshold) : undefined,
          allowVpsFallback:
            bodyJson.allowVpsFallback !== undefined ? Boolean(bodyJson.allowVpsFallback) : undefined,
          verifyBeforeAssign:
            bodyJson.verifyBeforeAssign !== undefined ? Boolean(bodyJson.verifyBeforeAssign) : undefined,
          blockSharedVpsDomino:
            bodyJson.blockSharedVpsDomino !== undefined ? Boolean(bodyJson.blockSharedVpsDomino) : undefined,
        });
        const snapshot = await getAdminProxyPoolSnapshot();
        return NextResponse.json({ success: true, ...snapshot, settings: updatedSettings });
      }

      default:
        return NextResponse.json({ success: false, error: "Ação inválida no gerenciador de proxies." }, { status: 400 });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /nenhum proxy válido|obrigatóri|inválid|excede/i.test(msg) ? 400 : 500;
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}
