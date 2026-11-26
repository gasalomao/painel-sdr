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
    const commentStr = `warmup_uid=${uid}`;
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

export function getWarmupVoiceSampleCount(): number {
  if (_cachedSamples.length === 0) {
    getRandomWarmupVoiceBase64();
  }
  return _cachedSamples.length;
}

/**
 * Retorna uma nota de voz Opus real (base64) com áudio e waveform autênticos para WhatsApp PTT,
 * evitando repetir o mesmo sample em envios consecutivos e garantindo hash SHA-256 único por envio.
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
    const uniqueBuf = uniquifyOggOpusBuffer(_cachedSamples[idx], uniqueSeed);
    return uniqueBuf.toString("base64");
  }

  // Fallback seguro caso os arquivos não sejam encontrados
  return "";
}
