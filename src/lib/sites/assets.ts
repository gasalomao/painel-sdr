import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { getProject } from "./repository";
import { getSitesDb } from "./server";
import { assertWebsiteOrigin, assertWebsiteUuid, readWebsiteBody, WebsiteInstructionError } from "./prompts";
import { getWebsiteAssetReferences, siteAssetPublicPath } from "./asset-preview";
import type { WebsiteAsset, WebsiteFiles } from "./types";

export const WEBSITE_ASSET_BUCKET = "website-assets";
export const MAX_WEBSITE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_WEBSITE_ASSETS = 20;
export const WEBSITE_ASSET_URL_TTL = 300;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

type ImageInfo = { mime: string; extension: string; width: number; height: number };

function invalidImage(): never { throw new WebsiteInstructionError("Imagem inválida. Envie PNG, JPEG ou WEBP íntegro; SVG não é aceito.", 415); }

export function validateWebsiteImage(bytes: Uint8Array, declaredMime: string): ImageInfo {
  if (!bytes.length || bytes.length > MAX_WEBSITE_ASSET_BYTES) throw new WebsiteInstructionError("Imagem deve ter até 8 MB.", 413);
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime = "";
  let width = 0;
  let height = 0;
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = "image/png";
    let offset = 8;
    let header = false;
    let pixels = false;
    let ended = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset);
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (size > data.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) invalidImage();
      if (!header && type !== "IHDR") invalidImage();
      if (type === "IHDR") {
        if (header || size !== 13) invalidImage();
        header = true;
        width = data.readUInt32BE(offset + 8);
        height = data.readUInt32BE(offset + 12);
        const depth = data[offset + 16];
        const color = data[offset + 17];
        const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!allowedDepths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] > 1) invalidImage();
      } else if (type === "IDAT") { pixels ||= size > 0; }
      else if (type === "IEND") {
        if (size !== 0 || offset + 12 !== data.length || !pixels) invalidImage();
        ended = true;
      } else if (type === "acTL" || type === "fcTL" || type === "fdAT") invalidImage();
      offset += size + 12;
    }
    if (!ended || offset !== data.length) invalidImage();
  } else if (data.length >= 16 && data[0] === 0xff && data[1] === 0xd8) {
    mime = "image/jpeg";
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) invalidImage();
    let offset = 2;
    let scan = false;
    while (offset + 4 <= data.length - 2) {
      if (data[offset++] !== 0xff) invalidImage();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > data.length) invalidImage();
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length - 2) invalidImage();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (width || size < 8 || data[offset + 2] !== 8 || size !== 8 + data[offset + 7] * 3) invalidImage();
        height = data.readUInt16BE(offset + 3);
        width = data.readUInt16BE(offset + 5);
      }
      if (marker === 0xda) {
        if (size < 6 || !width || offset + size >= data.length - 2) invalidImage();
        scan = true;
        break;
      }
      offset += size;
    }
    if (!scan) invalidImage();
  } else if (data.length >= 26 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
    mime = "image/webp";
    if (data.readUInt32LE(4) + 8 !== data.length) invalidImage();
    let offset = 12;
    let pixels = false;
    let canvas: [number, number] | undefined;
    while (offset + 8 <= data.length) {
      const type = data.toString("ascii", offset, offset + 4);
      const size = data.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (size > data.length - start) invalidImage();
      if (type === "VP8X") {
        if (offset !== 12 || size !== 10 || (data[start] & 0xc3) !== 0 || data[start + 1] || data[start + 2] || data[start + 3]) invalidImage();
        canvas = [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
      } else if (type === "VP8 ") {
        if (pixels || size < 10 || (data[start] & 1) !== 0 || !data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalidImage();
        width = data.readUInt16LE(start + 6) & 0x3fff;
        height = data.readUInt16LE(start + 8) & 0x3fff;
        pixels = true;
      } else if (type === "VP8L") {
        if (pixels || size < 5 || data[start] !== 0x2f || data[start + 4] >> 5 !== 0) invalidImage();
        const bits = data.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        pixels = true;
      } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(type)) invalidImage();
      offset = start + size + (size % 2);
    }
    if (!pixels || offset !== data.length || (canvas && (width !== canvas[0] || height !== canvas[1]))) invalidImage();
  } else { invalidImage(); }
  if (mime !== declaredMime || width < 1 || height < 1 || width > 12000 || height > 12000 || width * height > 40_000_000) invalidImage();
  return { mime, extension: extensions[mime], width, height };
}

export function websiteAssetPath(clientId: string, projectId: string, assetId: string, mime: string): string {
  [clientId, projectId, assetId].forEach(assertWebsiteUuid);
  if (!Object.hasOwn(extensions, mime)) invalidImage();
  return `${clientId}/${projectId}/${assetId}.${extensions[mime]}`;
}

export type WebsiteUpload = { file: File; purpose: WebsiteAsset["purpose"]; licenseConfirmed: true; bytes: Uint8Array; image: ImageInfo };

export async function parseWebsiteUpload(request: Request): Promise<WebsiteUpload> {
  assertWebsiteOrigin(request);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new WebsiteInstructionError("Envie multipart/form-data.", 415);
  const body = await readWebsiteBody(request, MAX_WEBSITE_ASSET_BYTES + 64 * 1024);
  let form: FormData;
  try { form = await new Response(Buffer.from(body), { headers: { "content-type": contentType } }).formData(); }
  catch { throw new WebsiteInstructionError("Formulário inválido."); }
  const keys = [...form.keys()];
  if (keys.some((key) => !["file", "purpose", "license_confirmed"].includes(key)) || new Set(keys).size !== keys.length) throw new WebsiteInstructionError("Campos de upload inválidos.");
  if (form.get("license_confirmed") !== "true") throw new WebsiteInstructionError("Confirme que possui licença ou autorização para usar a imagem.");
  const file = form.get("file");
  const purpose = form.get("purpose");
  if (!file || typeof file === "string" || !file.name.trim() || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name)) throw new WebsiteInstructionError("Arquivo ou nome inválido.");
  if (typeof purpose !== "string" || !["logo", "content", "reference"].includes(purpose)) throw new WebsiteInstructionError("Finalidade inválida.");
  if (file.size > MAX_WEBSITE_ASSET_BYTES) throw new WebsiteInstructionError("Imagem deve ter até 8 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = validateWebsiteImage(bytes, file.type);
  return { file, purpose: purpose as WebsiteAsset["purpose"], licenseConfirmed: true, bytes, image };
}

function assertAssetScope(asset: WebsiteAsset, clientId: string, projectId: string): void {
  if (asset.client_id !== clientId || asset.project_id !== projectId || asset.path !== websiteAssetPath(clientId, projectId, asset.id, asset.mime)) throw new WebsiteInstructionError("Asset fora do projeto.", 404);
}

async function signAssets(clientId: string, projectId: string, assets: WebsiteAsset[]): Promise<WebsiteAsset[]> {
  assets.forEach((asset) => assertAssetScope(asset, clientId, projectId));
  return Promise.all(assets.map(async (asset) => {
    if (asset.status === "deleting") throw new WebsiteInstructionError("Asset em exclusão.", 409);
    const { data, error } = await supabaseAdmin.storage.from(WEBSITE_ASSET_BUCKET).createSignedUrl(asset.path, WEBSITE_ASSET_URL_TTL);
    if (error || !data?.signedUrl) throw new WebsiteInstructionError("Não foi possível assinar o asset.", 503);
    return { ...asset, url: data.signedUrl };
  }));
}

export async function getSelectedAssets(clientId: string, projectId: string, ids: string[]): Promise<WebsiteAsset[]> {
  [clientId, projectId].forEach(assertWebsiteUuid);
  if (!Array.isArray(ids) || ids.length > MAX_WEBSITE_ASSETS) throw new WebsiteInstructionError("Selecione até 20 assets.");
  ids.forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  if (!ids.length) return [];
  const uniqueIds = [...new Set(ids)];
  const { data, error } = await getSitesDb().from("website_assets").select("*").eq("client_id", clientId).eq("project_id", projectId).eq("status", "ready").in("id", uniqueIds).limit(MAX_WEBSITE_ASSETS);
  if (error) throw new WebsiteInstructionError("Não foi possível carregar os assets.", 503);
  const assets = (data ?? []) as WebsiteAsset[];
  if (assets.length !== uniqueIds.length || assets.some((asset) => !uniqueIds.includes(asset.id))) throw new WebsiteInstructionError("Asset não encontrado neste projeto.", 404);
  const ordered = uniqueIds.map((id) => assets.find((asset) => asset.id === id)!);
  return signAssets(clientId, projectId, ordered);
}

export async function getReferencedAssets(clientId: string, projectId: string, files: WebsiteFiles): Promise<WebsiteAsset[]> {
  [clientId, projectId].forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  const references = getWebsiteAssetReferences(files);
  if (!references.length) return [];
  const ids = [...new Set(references.map(({ id }) => id))];
  if (ids.length > MAX_WEBSITE_ASSETS) throw new WebsiteInstructionError("Limite de assets excedido.", 409);
  const { data, error } = await getSitesDb().from("website_assets").select("*").eq("client_id", clientId).eq("project_id", projectId)
    .eq("status", "ready").in("purpose", ["logo", "content"]).in("id", ids).limit(MAX_WEBSITE_ASSETS);
  if (error) throw new WebsiteInstructionError("Não foi possível carregar os assets.", 503);
  const assets = (data ?? []) as WebsiteAsset[];
  assets.forEach((asset) => assertAssetScope(asset, clientId, projectId));
  if (assets.length !== ids.length || references.some(({ id, path }) => !assets.some((asset) =>
    asset.id === id && asset.status === "ready" && ["logo", "content"].includes(asset.purpose) && siteAssetPublicPath(asset) === path))) {
    throw new WebsiteInstructionError("Asset publicável não encontrado neste projeto.", 404);
  }
  return ids.map((id) => assets.find((asset) => asset.id === id)!);
}

export async function listWebsiteAssets(clientId: string, projectId: string): Promise<WebsiteAsset[]> {
  [clientId, projectId].forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().from("website_assets").select("*").eq("client_id", clientId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(MAX_WEBSITE_ASSETS + 1);
  if (error) throw new WebsiteInstructionError("Não foi possível carregar os assets.", 503);
  if ((data?.length ?? 0) > MAX_WEBSITE_ASSETS) throw new WebsiteInstructionError("Limite de assets excedido.", 409);
  const assets = (data ?? []) as WebsiteAsset[];
  return Promise.all(assets.map(async (asset) => asset.status === "ready" ? (await signAssets(clientId, projectId, [asset]))[0] : asset));
}

export async function uploadWebsiteAsset(clientId: string, projectId: string, upload: WebsiteUpload, actorId: string): Promise<WebsiteAsset> {
  [clientId, projectId, actorId].forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  if (upload.licenseConfirmed !== true || !["logo", "content", "reference"].includes(upload.purpose)) throw new WebsiteInstructionError("Finalidade e confirmação de licença obrigatórias.");
  const image = validateWebsiteImage(upload.bytes, upload.file.type);
  const id = randomUUID();
  const asset: WebsiteAsset = {
    id, client_id: clientId, project_id: projectId, name: upload.file.name,
    path: websiteAssetPath(clientId, projectId, id, image.mime), mime: image.mime,
    size: upload.bytes.length, width: image.width, height: image.height,
    purpose: upload.purpose, status: "pending", created_at: new Date().toISOString(),
  };
  const reserve = await getSitesDb().rpc("website_reserve_asset", {
    p_client_id: clientId, p_project_id: projectId, p_actor_id: actorId, p_asset: asset,
  });
  if (reserve.error) throw new WebsiteInstructionError("Não foi possível reservar o asset. Verifique os limites de armazenamento.", 409);
  const { error: storageError } = await supabaseAdmin.storage.from(WEBSITE_ASSET_BUCKET).upload(asset.path, upload.bytes, { contentType: asset.mime, cacheControl: "300", upsert: false });
  if (storageError) {
    const { error: cleanupError } = await getSitesDb().from("website_assets").update({ status: "failed" }).eq("client_id", clientId).eq("project_id", projectId).eq("id", id).eq("status", "pending");
    throw new WebsiteInstructionError(cleanupError ? "Upload interrompido. Exclua o asset pendente antes de tentar novamente." : "Não foi possível armazenar a imagem.", 503);
  }
  const { data: confirmed, error: confirmError } = await getSitesDb().from("website_assets").update({ status: "ready" }).eq("client_id", clientId).eq("project_id", projectId).eq("id", id).eq("status", "pending").select("*").maybeSingle();
  if (confirmError || !confirmed) throw new WebsiteInstructionError("Upload não pôde ser confirmado. Exclua o asset pendente e tente novamente.", 503);
  return (await signAssets(clientId, projectId, [confirmed as WebsiteAsset]))[0];
}

export async function updateWebsiteAsset(clientId: string, projectId: string, assetId: string, input: unknown): Promise<WebsiteAsset> {
  [clientId, projectId, assetId].forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WebsiteInstructionError("Asset inválido.");
  const body = input as Record<string, unknown>;
  if (!Object.keys(body).length || Object.keys(body).some((key) => !["name", "purpose"].includes(key))) throw new WebsiteInstructionError("Campos não permitidos.");
  const patch: Partial<Pick<WebsiteAsset, "name" | "purpose">> = {};
  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(body.name)) throw new WebsiteInstructionError("Nome inválido.");
    patch.name = body.name.trim();
  }
  if ("purpose" in body) {
    if (!["logo", "content", "reference"].includes(body.purpose as string)) throw new WebsiteInstructionError("Finalidade inválida.");
    patch.purpose = body.purpose as WebsiteAsset["purpose"];
  }
  const { data, error } = await supabaseAdmin.from("website_assets").update(patch).eq("client_id", clientId).eq("project_id", projectId).eq("id", assetId).select("*").maybeSingle();
  if (error) throw new WebsiteInstructionError("Não foi possível atualizar o asset.", 503);
  if (!data) throw new WebsiteInstructionError("Asset não encontrado.", 404);
  return (await signAssets(clientId, projectId, [data as WebsiteAsset]))[0];
}

export async function deleteWebsiteAsset(clientId: string, projectId: string, assetId: string): Promise<void> {
  [clientId, projectId, assetId].forEach(assertWebsiteUuid);
  await getProject(clientId, projectId);
  const { data, error } = await getSitesDb().from("website_assets").select("*").eq("client_id", clientId).eq("project_id", projectId).eq("id", assetId).maybeSingle();
  if (error) throw new WebsiteInstructionError("Não foi possível carregar o asset.", 503);
  if (!data) return;
  const asset = data as WebsiteAsset;
  assertAssetScope(asset, clientId, projectId);
  if (asset.id !== assetId || !asset.status || !["ready", "pending", "failed", "deleting"].includes(asset.status)) throw new WebsiteInstructionError("Asset inválido.", 409);
  const { data: marked, error: markError } = await getSitesDb().from("website_assets").update({ status: "deleting" })
    .eq("client_id", clientId).eq("project_id", projectId).eq("id", assetId).eq("path", asset.path)
    .in("status", [...new Set([asset.status, "deleting"])]).select("id").maybeSingle();
  if (markError) throw new WebsiteInstructionError("Não foi possível marcar o asset para exclusão.", 503);
  if (!marked) {
    const current = await getSitesDb().from("website_assets").select("id").eq("client_id", clientId).eq("project_id", projectId).eq("id", assetId).maybeSingle();
    if (current.error || current.data) throw new WebsiteInstructionError("Asset alterado durante a exclusão. Tente novamente.", 409);
    return;
  }
  const { error: storageError } = await supabaseAdmin.storage.from(WEBSITE_ASSET_BUCKET).remove([asset.path]);
  if (storageError) throw new WebsiteInstructionError("Não foi possível excluir o arquivo. Tente novamente.", 503);
  const { error: deleteError } = await getSitesDb().from("website_assets").delete().eq("client_id", clientId).eq("project_id", projectId).eq("id", assetId).eq("path", asset.path).eq("status", "deleting");
  if (deleteError) throw new WebsiteInstructionError("Arquivo removido; tente excluir novamente para concluir a limpeza do registro.", 503);
}
