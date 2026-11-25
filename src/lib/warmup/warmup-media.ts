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

/**
 * Gera uma imagem PNG real (192x192 RGBA) com padrão abstrato minimalista e
 * ruído criptográfico imperceptível para garantir hash SHA-256 único a cada envio.
 */
export function createDynamicWarmupImage(seed?: string): {
  base64: string;
  mimetype: string;
  caption: string;
  sha256: string;
} {
  const entropy = crypto
    .createHash("sha256")
    .update(`${seed || "wup"}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`)
    .digest();

  const width = 192;
  const height = 192;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);

  const bgR = 24 + (entropy[0] % 48);
  const bgG = 36 + (entropy[1] % 56);
  const bgB = 52 + (entropy[2] % 64);
  const acR = 120 + (entropy[3] % 110);
  const acG = 140 + (entropy[4] % 95);
  const acB = 130 + (entropy[5] % 105);

  const cx = 64 + (entropy[6] % 64);
  const cy = 64 + (entropy[7] % 64);
  const radius = 38 + (entropy[8] % 34);
  const diagShift = entropy[9] % 40;

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const inCircle = dx * dx + dy * dy <= radius * radius;
      const inBand = Math.abs((x + y + diagShift) % 48) < 10;

      // Variação mínima de +/- 1 bits por pixel aleatório impede duplicação de hash binário
      const microNoise = ((entropy[(x + y) % entropy.length] ^ (x * 7 + y * 13)) & 1) === 1 ? 1 : 0;

      let r = Math.min(255, bgR + Math.floor((x / width) * 55) + microNoise);
      let g = Math.min(255, bgG + Math.floor((y / height) * 55));
      let b = Math.min(255, bgB + Math.floor(((x + y) / (width + height)) * 45));

      if (inCircle) {
        r = Math.min(255, acR + microNoise);
        g = Math.min(255, acG);
        b = Math.min(255, acB);
      } else if (inBand) {
        r = Math.min(255, r + 18);
        g = Math.min(255, g + 22);
        b = Math.min(255, b + 16);
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
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
