import crypto from "crypto";
import zlib from "zlib";

/**
 * Pool de legendas casuais e humanas para imagens no aquecimento (nunca promocionais).
 */
export const CASUAL_IMAGE_CAPTIONS: string[] = [
  "olha isso aqui",
  "salvei aqui pra te mostrar",
  "registro rápido de hoje",
  "dá uma olhada quando puder",
  "tava testando essa paleta",
  "achei massa esse visual",
  "anotei aqui pra não esquecer",
  "ficou simples mas curti",
];

/**
 * Pool de enquetes casuais de baixa fricção (uso esparso a partir da Fase 3).
 */
export const CASUAL_WARMUP_POLLS: Array<{ name: string; values: string[] }> = [
  { name: "O que prefere pra hoje?", values: ["Café", "Água gelada", "Chá"] },
  { name: "Você prefere resolver isso:", values: ["Ainda hoje", "Amanhã cedo"] },
  { name: "Melhor horário pra falar com vc?", values: ["Manhã", "Tarde", "Tanto faz"] },
  { name: "Fim de semana tá mais pra:", values: ["Descansar", "Sair um pouco", "Colocar tudo em dia"] },
  { name: "Almoço de hoje vai ser:", values: ["Caseiro", "Pedir fora"] },
];

// ============================================================================
// GERADOR DE PNG ÚNICO POR HASH (usando zlib nativo do Node — zero deps)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

const ORGANIC_IMAGE_DIMENSIONS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 320, height: 240 },
  { width: 280, height: 360 },
  { width: 256, height: 256 },
  { width: 360, height: 270 },
  { width: 240, height: 320 },
  { width: 336, height: 224 },
  { width: 288, height: 288 },
  { width: 300, height: 380 },
];

/**
 * Gera uma imagem PNG real (RGBA com dimensões orgânicas variadas entre retrato, quadrado e paisagem)
 * com composição multi-banda suave e micro-ruído criptográfico para garantir dimensões e hash SHA-256
 * únicos a cada envio (evitando fingerprint de imagem estática 192x192).
 */
export function createDynamicWarmupImage(seed?: string): {
  base64: string;
  mimetype: string;
  caption: string;
  sha256: string;
  width: number;
  height: number;
} {
  const entropy = crypto
    .createHash("sha256")
    .update(`${seed || "wup"}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
    .digest();

  const preset = ORGANIC_IMAGE_DIMENSIONS[entropy[12] % ORGANIC_IMAGE_DIMENSIONS.length];
  const widthJitter = (entropy[13] % 7) * 2; // 0..12px
  const heightJitter = (entropy[14] % 7) * 2; // 0..12px
  const width = preset.width + widthJitter;
  const height = preset.height + heightJitter;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);

  // Paletas suaves naturais (céu/ambiente, quente ou neutro)
  const bgR = 26 + (entropy[0] % 58);
  const bgG = 38 + (entropy[1] % 64);
  const bgB = 54 + (entropy[2] % 72);
  const acR = 115 + (entropy[3] % 115);
  const acG = 135 + (entropy[4] % 100);
  const acB = 125 + (entropy[5] % 110);
  const band2R = 70 + (entropy[15] % 95);
  const band2G = 90 + (entropy[16] % 95);
  const band2B = 105 + (entropy[17] % 95);

  const cx = Math.floor(width * (0.28 + (entropy[6] / 255) * 0.44));
  const cy = Math.floor(height * (0.25 + (entropy[7] / 255) * 0.45));
  const minDim = Math.min(width, height);
  const radius = Math.floor(minDim * (0.17 + (entropy[8] / 255) * 0.14));
  const radiusSq = radius * radius;
  const diagShift = entropy[9] % 56;
  const horizonBase = Math.floor(height * (0.56 + (entropy[18] / 255) * 0.18));
  const waveAmp = 8 + (entropy[19] % 14);
  const waveFreq = 0.018 + (entropy[20] % 12) * 0.002;
  const wavePhase = (entropy[21] / 255) * Math.PI * 2;
  const stripePeriod = 38 + (entropy[22] % 24);
  const stripeWidth = 8 + (entropy[23] % 8);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter None
    const yRatio = y / height;

    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 4;
      const xRatio = x / width;
      const dx = x - cx;
      const dy = y - cy;
      const distSq = dx * dx + dy * dy;

      const horizonY = horizonBase + Math.sin(x * waveFreq + wavePhase) * waveAmp;
      const belowHorizon = y >= horizonY;
      const inBand = ((x + y + diagShift) % stripePeriod) < stripeWidth;

      // Micro-ruído de 1-2 bits por pixel impede duplicação de hash binário ou perceptual simples
      const eByte = entropy[(x * 3 + y * 5) % entropy.length];
      const microR = ((eByte ^ (x * 7 + y * 13)) & 3) === 1 ? 1 : 0;
      const microG = (((eByte >> 2) ^ (x * 11 + y * 3)) & 3) === 2 ? 1 : 0;
      const microB = (((eByte >> 4) ^ (x * 5 + y * 17)) & 3) === 3 ? 1 : 0;

      let r = bgR + Math.floor(xRatio * 52 + yRatio * 24);
      let g = bgG + Math.floor(yRatio * 58 + (1 - xRatio) * 18);
      let b = bgB + Math.floor(((xRatio + yRatio) * 0.5) * 48);

      if (belowHorizon) {
        const depth = Math.min(1, (y - horizonY) / Math.max(1, height - horizonBase));
        r = Math.floor(r * 0.55 + band2R * 0.45 * (1 - depth * 0.25));
        g = Math.floor(g * 0.55 + band2G * 0.45 * (1 - depth * 0.2));
        b = Math.floor(b * 0.55 + band2B * 0.45 * (1 - depth * 0.15));
      } else if (inBand) {
        r += 14;
        g += 18;
        b += 14;
      }

      if (distSq <= radiusSq) {
        const falloff = 1 - Math.sqrt(distSq) / Math.max(1, radius);
        const blend = 0.45 + falloff * 0.5;
        r = Math.floor(r * (1 - blend) + acR * blend);
        g = Math.floor(g * (1 - blend) + acG * blend);
        b = Math.floor(b * (1 - blend) + acB * blend);
      }

      raw[idx] = Math.min(255, Math.max(0, r + microR));
      raw[idx + 1] = Math.min(255, Math.max(0, g + microG));
      raw[idx + 2] = Math.min(255, Math.max(0, b + microB));
      raw[idx + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngBuffer = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  const useCaption = (entropy[10] & 1) === 0;
  const caption = useCaption
    ? CASUAL_IMAGE_CAPTIONS[entropy[11] % CASUAL_IMAGE_CAPTIONS.length]
    : "";

  return {
    base64: pngBuffer.toString("base64"),
    mimetype: "image/png",
    caption,
    sha256: crypto.createHash("sha256").update(pngBuffer).digest("hex"),
    width,
    height,
  };
}

// ============================================================================
// GERADOR DE FIGURINHA WebP LOSSLESS (RIFF/WEBP VP8L) ÚNICA POR HASH
// ============================================================================

class LsbBitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private bitPos = 0;

  writeBits(val: number, count: number): void {
    let v = val >>> 0;
    for (let i = 0; i < count; i++) {
      this.cur |= (v & 1) << this.bitPos;
      this.bitPos++;
      v >>>= 1;
      if (this.bitPos === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.bitPos = 0;
      }
    }
  }

  toBuffer(): Buffer {
    if (this.bitPos > 0) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.bitPos = 0;
    }
    return Buffer.from(this.bytes);
  }
}

function writeSimpleTwoSymbolCode(bw: LsbBitWriter, sym0: number, sym1: number): void {
  bw.writeBits(1, 1); // simple_code_length = 1
  bw.writeBits(1, 1); // num_symbols - 1 = 1 (2 symbols)
  bw.writeBits(1, 1); // first_symbol_length_code = 1 (8 bits)
  bw.writeBits(sym0 & 0xff, 8);
  bw.writeBits(sym1 & 0xff, 8);
}

function writeSimpleOneSymbolCode(bw: LsbBitWriter, sym0: number): void {
  bw.writeBits(1, 1); // simple_code_length = 1
  bw.writeBits(0, 1); // num_symbols - 1 = 0 (1 symbol)
  bw.writeBits(1, 1); // first_symbol_length_code = 1 (8 bits)
  bw.writeBits(sym0 & 0xff, 8);
}

/**
 * Gera uma figurinha WebP Lossless (VP8L 128x128 RGBA com fundo transparente)
 * 100% aderente à especificação RFC RIFF/VP8L e com assinatura binária única por envio.
 */
export function createDynamicWarmupSticker(seed?: string): {
  base64: string;
  sha256: string;
} {
  const entropy = crypto
    .createHash("sha256")
    .update(`${seed || "stk"}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
    .digest();

  const size = 128;
  const bw = new LsbBitWriter();

  // VP8L signature byte (0x2f) + header 28+3+1 bits: width-1 (14b), height-1 (14b), alpha=1 (1b), version=0 (3b)
  bw.writeBits(0x2f, 8);
  bw.writeBits(size - 1, 14);
  bw.writeBits(size - 1, 14);
  bw.writeBits(1, 1); // alpha_is_used = 1
  bw.writeBits(0, 3); // version_number = 0

  // Stream image: no transform (0), no color cache (0), no meta prefix codes (0)
  bw.writeBits(0, 1); // transform = 0
  bw.writeBits(0, 1); // color_cache = 0
  bw.writeBits(0, 1); // meta_huffman = 0

  // Paleta de 2 símbolos por canal -> 16 combinações com geometria arredondada e alpha transparente
  const g0 = 70 + (entropy[0] % 80);
  const g1 = 180 + (entropy[1] % 70);
  const r0 = 35 + (entropy[2] % 90);
  const r1 = 190 + (entropy[3] % 65);
  const b0 = 60 + (entropy[4] % 90);
  const b1 = 195 + (entropy[5] % 60);

  writeSimpleTwoSymbolCode(bw, g0, g1); // Green + length (simbolos < 256)
  writeSimpleTwoSymbolCode(bw, r0, r1); // Red
  writeSimpleTwoSymbolCode(bw, b0, b1); // Blue
  writeSimpleTwoSymbolCode(bw, 0, 255); // Alpha (0 transparente, 255 opaco)
  writeSimpleOneSymbolCode(bw, 0);      // Distance (não usado, 0 bits no stream)

  const shapeVariant = entropy[6] % 3;
  const centerX = 64 + ((entropy[7] % 9) - 4);
  const centerY = 64 + ((entropy[8] % 9) - 4);
  const jitterByte = entropy[9];
  const radiusSq = 54 * 54;
  const innerSq = (26 + (entropy[10] % 10)) ** 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distSq = dx * dx + dy * dy;

      const insideSticker = distSq <= radiusSq;
      let isHighlight = false;
      if (insideSticker) {
        if (shapeVariant === 0) {
          isHighlight = distSq <= innerSq || (Math.abs(dx) < 10 && Math.abs(dy) < 42);
        } else if (shapeVariant === 1) {
          isHighlight = Math.abs(dx + dy) < 16 || Math.abs(dx - dy) < 16;
        } else {
          isHighlight = distSq <= innerSq && ((x + y) % 8 < 4);
        }
      }

      // Micro-entropia determinística no interior da figurinha garante SHA-256 diferente mesmo no mesmo shape
      const microFlip = insideSticker && x === (jitterByte % 64) + 32 && y === (entropy[11] % 64) + 32 ? 1 : 0;
      const gBit = (isHighlight ? 1 : 0) ^ microFlip;
      const rBit = (shapeVariant === 1 ? (isHighlight ? 1 : 0) : (insideSticker && y < centerY ? 1 : 0));
      const bBit = insideSticker && !isHighlight ? 1 : 0;
      const aBit = insideSticker ? 1 : 0;

      // Ordem do padrão VP8L com código de 2 símbolos: 0 -> sym0, 1 -> sym1
      bw.writeBits(gBit, 1);
      bw.writeBits(rBit, 1);
      bw.writeBits(bBit, 1);
      bw.writeBits(aBit, 1);
    }
  }

  const vp8lPayload = bw.toBuffer();
  const paddedPayload = vp8lPayload.length % 2 === 1
    ? Buffer.concat([vp8lPayload, Buffer.from([0])])
    : vp8lPayload;

  const vp8lChunkHeader = Buffer.alloc(8);
  vp8lChunkHeader.write("VP8L", 0, "ascii");
  vp8lChunkHeader.writeUInt32LE(vp8lPayload.length, 4);

  const riffPayloadSize = 4 + vp8lChunkHeader.length + paddedPayload.length;
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, "ascii");
  riffHeader.writeUInt32LE(riffPayloadSize, 4);
  riffHeader.write("WEBP", 8, "ascii");

  const webpBuffer = Buffer.concat([riffHeader, vp8lChunkHeader, paddedPayload]);
  return {
    base64: webpBuffer.toString("base64"),
    sha256: crypto.createHash("sha256").update(webpBuffer).digest("hex"),
  };
}

export function pickCasualWarmupPoll(seed?: string): { name: string; values: string[]; selectableCount: number } {
  const entropy = crypto
    .createHash("sha256")
    .update(`${seed || "poll"}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`)
    .digest();
  const selected = CASUAL_WARMUP_POLLS[entropy[0] % CASUAL_WARMUP_POLLS.length];
  return {
    name: selected.name,
    values: [...selected.values],
    selectableCount: 1,
  };
}
