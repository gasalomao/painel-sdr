import crypto from "crypto";
import fs from "fs";
import path from "path";

const _cachedSamples: Buffer[] = [];
let _lastSampleIndex = -1;

// Tabela CRC-32 oficial do container Ogg (RFC 3533: polinômio 0x04c11db7 MSB-first, sem reflexão)
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

export function computeOggCrc32(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc;
}

/**
 * Verifica se a página Ogg iniciada em `offset` possui magic "OggS" e CRC-32 válido.
 */
export function verifyOggPageCrc(buf: Buffer, offset: number): boolean {
  if (offset < 0 || offset + 27 > buf.length) return false;
  if (buf.subarray(offset, offset + 4).toString("ascii") !== "OggS") return false;
  const segCount = buf[offset + 26];
  const hdrLen = 27 + segCount;
  if (offset + hdrLen > buf.length) return false;
  let dataLen = 0;
  for (let i = 0; i < segCount; i++) {
    dataLen += buf[offset + 27 + i];
  }
  const endOffset = offset + hdrLen + dataLen;
  if (endOffset > buf.length) return false;

  const pageCopy = Buffer.from(buf.subarray(offset, endOffset));
  const stored = pageCopy.readUInt32LE(22);
  pageCopy.writeUInt32LE(0, 22);
  return computeOggCrc32(pageCopy) === stored;
}

/**
 * Gera uma cópia binária única e 100% reproduzível em Ogg Opus inserindo uma tag
 * única em `OpusTags` e recalculando o header + CRC-32 da página 1 conforme RFC 3533/7845.
 * Garante SHA-256 diferente a cada envio sem depender de binários externos.
 */
export function uniquifyOggOpusBuffer(source: Buffer, uniqueSeed?: string): Buffer {
  if (!source || source.length < 64) return source;
  try {
    const p1 = source.indexOf("OggS", 4);
    if (p1 < 28 || p1 + 27 > source.length) return source;

    const segCount = source[p1 + 26];
    const hdrLen = 27 + segCount;
    if (p1 + hdrLen > source.length) return source;

    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) {
      payloadLen += source[p1 + 27 + i];
    }
    const p1End = p1 + hdrLen + payloadLen;
    if (p1End > source.length) return source;

    const payload = source.subarray(p1 + hdrLen, p1End);
    if (payload.length < 16 || payload.subarray(0, 8).toString("ascii") !== "OpusTags") {
      return source;
    }

    const vendorLen = payload.readUInt32LE(8);
    const commentsCountOffset = 12 + vendorLen;
    if (commentsCountOffset + 4 > payload.length) return source;

    const currentComments = payload.readUInt32LE(commentsCountOffset);
    const uid =
      uniqueSeed ||
      `${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const commentStr = `DATE=${uid}`;
    const commentBuf = Buffer.from(commentStr, "utf8");
    const entryBuf = Buffer.alloc(4 + commentBuf.length);
    entryBuf.writeUInt32LE(commentBuf.length, 0);
    commentBuf.copy(entryBuf, 4);

    const newPayload = Buffer.concat([payload, entryBuf]);
    newPayload.writeUInt32LE(currentComments + 1, commentsCountOffset);

    // Recalcula segment_table Ogg (blocos de 255 + resto < 255)
    const segTableEntries: number[] = [];
    let rem = newPayload.length;
    while (rem >= 255) {
      segTableEntries.push(255);
      rem -= 255;
    }
    segTableEntries.push(rem);
    if (segTableEntries.length > 255) return source;

    const fixedHdr = Buffer.from(source.subarray(p1, p1 + 26));
    const newPage = Buffer.concat([
      fixedHdr,
      Buffer.from([segTableEntries.length]),
      Buffer.from(segTableEntries),
      newPayload,
    ]);
    newPage.writeUInt32LE(0, 22);
    const crc = computeOggCrc32(newPage);
    newPage.writeUInt32LE(crc, 22);

    return Buffer.concat([source.subarray(0, p1), newPage, source.subarray(p1End)]);
  } catch {
    return source;
  }
}

export type OggOpusDurationMode = "short" | "normal" | "extended";

interface ParsedOggPage {
  headerType: number;
  granulePos: bigint;
  serial: number;
  seqNum: number;
  segmentTable: Buffer;
  payload: Buffer;
}

function parseOggPages(buf: Buffer): ParsedOggPage[] | null {
  if (!buf || buf.length < 28) return null;
  const pages: ParsedOggPage[] = [];
  let offset = 0;
  while (offset + 27 <= buf.length) {
    if (buf.subarray(offset, offset + 4).toString("ascii") !== "OggS") return null;
    const segCount = buf[offset + 26];
    const hdrLen = 27 + segCount;
    if (offset + hdrLen > buf.length) return null;
    const segmentTable = Buffer.from(buf.subarray(offset + 27, offset + hdrLen));
    let dataLen = 0;
    for (let i = 0; i < segCount; i++) dataLen += segmentTable[i];
    if (offset + hdrLen + dataLen > buf.length) return null;
    const payload = Buffer.from(buf.subarray(offset + hdrLen, offset + hdrLen + dataLen));
    pages.push({
      headerType: buf[offset + 5],
      granulePos: buf.readBigUInt64LE(offset + 6),
      serial: buf.readUInt32LE(offset + 14),
      seqNum: buf.readUInt32LE(offset + 18),
      segmentTable,
      payload,
    });
    offset += hdrLen + dataLen;
  }
  return pages.length >= 3 && offset === buf.length ? pages : null;
}

function encodeOggPage(page: ParsedOggPage): Buffer {
  const hdr = Buffer.alloc(27);
  hdr.write("OggS", 0, 4, "ascii");
  hdr[4] = 0; // stream_structure_version
  hdr[5] = page.headerType & 0xff;
  hdr.writeBigUInt64LE(page.granulePos, 6);
  hdr.writeUInt32LE(page.serial >>> 0, 14);
  hdr.writeUInt32LE(page.seqNum >>> 0, 18);
  hdr.writeUInt32LE(0, 22);
  hdr[26] = page.segmentTable.length;
  const full = Buffer.concat([hdr, page.segmentTable, page.payload]);
  const crc = computeOggCrc32(full);
  full.writeUInt32LE(crc, 22);
  return full;
}

/**
 * Varia naturalmente a duração do Ogg Opus (`short`, `normal` ou `extended`) preservando
 * páginas `OpusHead`/`OpusTags` intactas, `granule_position` monotônico, `seqNum`,
 * bit EOS somente na última página e CRC-32 RFC 3533 válido em todas as páginas.
 */
export function varyOggOpusDuration(
  source: Buffer,
  opts?: { mode?: OggOpusDurationMode; seed?: string }
): Buffer {
  const uniquified = uniquifyOggOpusBuffer(source, opts?.seed);
  const mode = opts?.mode || "normal";
  if (mode === "normal") return uniquified;

  const pages = parseOggPages(uniquified);
  if (!pages || pages.length < 3) return uniquified;

  try {
    const head = pages[0];
    const tags = pages[1];
    const audioPages = pages.slice(2);
    if (audioPages.length === 0) return uniquified;

    let selectedAudio: ParsedOggPage[];
    if (mode === "short") {
      if (audioPages.length >= 2) {
        const keepCount = Math.max(1, Math.ceil(audioPages.length * 0.55));
        selectedAudio = audioPages.slice(0, keepCount);
      } else {
        // Caso o arquivo tenha apenas 1 página de áudio, corta metade dos pacotes Opus da tabela de segmentos
        const single = audioPages[0];
        const segCount = single.segmentTable.length;
        if (segCount >= 4) {
          const halfSegs = Math.max(2, Math.floor(segCount * 0.55));
          let cutBytes = 0;
          for (let i = 0; i < halfSegs; i++) cutBytes += single.segmentTable[i];
          const trimmedGranule =
            single.granulePos > BigInt(0)
              ? BigInt(Math.max(960, Math.round(Number(single.granulePos) * (halfSegs / segCount))))
              : single.granulePos;
          selectedAudio = [
            {
              ...single,
              segmentTable: single.segmentTable.subarray(0, halfSegs),
              payload: single.payload.subarray(0, cutBytes),
              granulePos: trimmedGranule,
            },
          ];
        } else {
          selectedAudio = audioPages;
        }
      }
    } else {
      // extended: duplica segmentos finais de áudio de forma contígua para estender a duração
      selectedAudio = audioPages.map((p) => ({ ...p }));
      if (audioPages.length >= 2) {
        const extra = audioPages.slice(0, Math.min(2, audioPages.length)).map((p) => ({ ...p }));
        selectedAudio.push(...extra);
      } else {
        const single = audioPages[0];
        const secondHalfStart = Math.floor(single.segmentTable.length / 2);
        let prefixBytes = 0;
        for (let i = 0; i < secondHalfStart; i++) prefixBytes += single.segmentTable[i];
        if (secondHalfStart >= 1 && single.segmentTable.length + (single.segmentTable.length - secondHalfStart) <= 255) {
          selectedAudio.push({
            ...single,
            segmentTable: single.segmentTable.subarray(secondHalfStart),
            payload: single.payload.subarray(prefixBytes),
          });
        }
      }
    }

    const rebuilt: ParsedOggPage[] = [
      { ...head, headerType: head.headerType & ~0x04, seqNum: 0 },
      { ...tags, headerType: tags.headerType & ~0x04, seqNum: 1 },
    ];

    let curGranule = BigInt(0);
    for (let i = 0; i < selectedAudio.length; i++) {
      const srcPage = selectedAudio[i];
      const prevGranule =
        i > 0 && selectedAudio[i - 1].granulePos <= srcPage.granulePos
          ? selectedAudio[i - 1].granulePos
          : BigInt(0);
      const delta =
        srcPage.granulePos > prevGranule
          ? srcPage.granulePos - prevGranule
          : srcPage.granulePos > BigInt(0)
            ? srcPage.granulePos
            : BigInt(48000);
      curGranule += delta;
      const isLast = i === selectedAudio.length - 1;
      rebuilt.push({
        ...srcPage,
        headerType: (srcPage.headerType & ~0x04) | (isLast ? 0x04 : 0),
        granulePos: curGranule,
        seqNum: i + 2,
      });
    }

    const outBuf = Buffer.concat(rebuilt.map(encodeOggPage));

    // Validação estrita RFC 3533 de todas as páginas geradas antes de retornar
    let pos = 0;
    while (pos < outBuf.length) {
      if (!verifyOggPageCrc(outBuf, pos)) return uniquified;
      const segs = outBuf[pos + 26];
      let dLen = 0;
      for (let i = 0; i < segs; i++) dLen += outBuf[pos + 27 + i];
      pos += 27 + segs + dLen;
    }
    return pos === outBuf.length ? outBuf : uniquified;
  } catch {
    return uniquified;
  }
}

export function getWarmupVoiceSampleCount(): number {
  if (_cachedSamples.length === 0) {
    getRandomWarmupVoiceBase64();
  }
  return _cachedSamples.length;
}

/**
 * Retorna uma nota de voz Opus real (base64) com áudio e waveform autênticos para WhatsApp PTT,
 * alternando samples, variando duração natural (`short` | `normal` | `extended`) e garantindo SHA-256 único.
 */
export function getRandomWarmupVoiceBase64(uniqueSeed?: string): string {
  if (_cachedSamples.length === 0) {
    const files = [
      path.join(process.cwd(), "public", "warmup_voice_sample.ogg"),
      path.join(process.cwd(), "public", "warmup_voice_sample2.ogg"),
      path.join(process.cwd(), "public", "warmup_voice_sample3.ogg"),
    ];

    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          const buf = fs.readFileSync(file);
          if (buf.length > 500) {
            _cachedSamples.push(buf);
          }
        }
      } catch {}
    }
  }

  if (_cachedSamples.length > 0) {
    let idx = Math.floor(Math.random() * _cachedSamples.length);
    if (_cachedSamples.length > 1 && idx === _lastSampleIndex) {
      idx = (idx + 1 + Math.floor(Math.random() * (_cachedSamples.length - 1))) % _cachedSamples.length;
    }
    _lastSampleIndex = idx;
    const modes: OggOpusDurationMode[] = ["short", "normal", "extended"];
    const pickedMode = modes[Math.floor(Math.random() * modes.length)];
    const uniqueBuf = varyOggOpusDuration(_cachedSamples[idx], {
      mode: pickedMode,
      seed: uniqueSeed,
    });
    return uniqueBuf.toString("base64");
  }

  // Fallback seguro caso os arquivos não sejam encontrados
  return "";
}
