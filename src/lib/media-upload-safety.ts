export const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  "svg", "svgz", "html", "htm", "xhtml", "shtml", "xml",
  "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "php", "phtml", "asp", "aspx", "jsp",
  "sh", "bash", "zsh", "bat", "cmd", "ps1", "vbs",
  "exe", "dll", "msi", "apk", "jar",
]);

export const SAFE_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-msvideo": "avi",
  "video/avi": "avi",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/vcard": "vcf",
  "text/x-vcard": "vcf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export const SAFE_EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  vcf: "text/vcard",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Resolve extensão e Content-Type seguros com base em allowlist explícita,
 * bloqueando extensões/MIMEs executáveis ou passíveis de XSS (SVG, HTML, JS).
 */
export function resolveSafeUploadFormat(
  fileName: string,
  mimeType: string
): { ext: string; contentType: string } | null {
  const rawBase = (fileName || "").trim();
  const dotIdx = rawBase.lastIndexOf(".");
  const rawExt = dotIdx >= 0 ? rawBase.slice(dotIdx + 1).toLowerCase().trim() : "";

  if (rawExt && BLOCKED_UPLOAD_EXTENSIONS.has(rawExt)) {
    return null;
  }

  const normalizedMime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (normalizedMime && normalizedMime !== "application/octet-stream") {
    const extFromMime = SAFE_MIME_TO_EXT[normalizedMime];
    if (!extFromMime) {
      return null;
    }
    if (rawExt) {
      const mimeFromExt = SAFE_EXT_TO_MIME[rawExt];
      const matches =
        mimeFromExt &&
        (SAFE_MIME_TO_EXT[mimeFromExt] === extFromMime ||
          (normalizedMime === "audio/mp4" && rawExt === "mp4"));
      if (!matches) {
        return null;
      }
    }
    return {
      ext: rawExt === "jpeg" ? "jpeg" : extFromMime,
      contentType: normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime,
    };
  }

  if (!rawExt || !SAFE_EXT_TO_MIME[rawExt]) {
    return null;
  }
  return {
    ext: rawExt === "jpeg" ? "jpg" : rawExt,
    contentType: SAFE_EXT_TO_MIME[rawExt],
  };
}

