import type { WebsiteAsset, WebsiteFiles, WebsiteProject } from "./types";

const assetReference = /(^|[\s"'`(=])(\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:png|jpg|webp))((?:\?[^\s"'`()<>#]*)?)(#[^\s"'`()<>]*)?(?=$|[\s"'`),;<>}])/g;

export function siteAssetPublicPath(asset: Pick<WebsiteAsset, "id" | "mime">): string {
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
  const extension = extensions[asset.mime];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asset.id) || !extension) throw new Error("Asset inválido.");
  return `/assets/${asset.id}.${extension}`;
}

export function getWebsiteAssetReferences(files: WebsiteFiles): Array<{ id: string; path: string }> {
  const references = new Map<string, { id: string; path: string }>();
  for (const content of Object.values(files)) {
    for (const match of content.matchAll(assetReference)) references.set(match[2], { id: match[3], path: match[2] });
  }
  return [...references.values()];
}

export function resolveWebsitePreviewAssets(files: WebsiteFiles, assets: readonly WebsiteAsset[], project: Pick<WebsiteProject, "client_id" | "id">): WebsiteFiles {
  const urls = new Map<string, string>();
  for (const asset of assets) {
    if (asset.status !== "ready" || !["logo", "content"].includes(asset.purpose) ||
      asset.client_id !== project.client_id || asset.project_id !== project.id || !asset.url || /[\s"'`()<>\\${}]/.test(asset.url)) continue;
    try {
      const path = siteAssetPublicPath(asset);
      if (asset.path !== `${project.client_id}/${project.id}/${path.slice("/assets/".length)}`) continue;
      const url = new URL(asset.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
      urls.set(path, asset.url);
    } catch { continue; }
  }
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path,
    content.replace(assetReference, (match, prefix: string, assetPath: string, _id: string, _query: string, fragment: string | undefined) => {
      const url = urls.get(assetPath);
      return url ? `${prefix}${url}${fragment ?? ""}` : match;
    }),
  ]));
}
