// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BRAND } from "../brand";

const root = process.cwd();

function publicAsset(url: string): Buffer {
  expect(url).toMatch(/^\/brand\//);
  return readFileSync(resolve(root, "public", url.slice(1)));
}

async function expectBrandColors(image: Buffer): Promise<void> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let greenPixels = 0;
  let cyanPixels = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue;
    if (data[i + 1] > data[i + 2] + 40 && data[i + 1] > 120) greenPixels++;
    if (data[i + 2] > data[i] + 40 && data[i + 1] > 100) cyanPixels++;
  }
  expect(greenPixels).toBeGreaterThan(100);
  expect(cyanPixels).toBeGreaterThan(100);
}

describe("identidade visual da plataforma", () => {
  it("distribui a logo oficial localmente, sem depender de CDN externa", async () => {
    const image = await sharp(publicAsset(BRAND.logoUrl)).metadata();
    expect(image.format).toBe("png");
    expect(image.hasAlpha).toBe(true);
  });

  it("usa a logo verde no favicon, não o ícone preto padrão do Next.js", async () => {
    const ico = readFileSync(resolve(root, "src/app/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const entry = 6 + (count - 1) * 16;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    await expectBrandColors(ico.subarray(offset, offset + size));
  });

  it.each([
    ["icon.png", 256],
    ["apple-icon.png", 180],
  ])("inclui %s local para abas e atalhos de celular", async (file, size) => {
    const image = readFileSync(resolve(root, "src/app", file));
    const metadata = await sharp(image).metadata();
    expect(metadata.width).toBe(size);
    expect(metadata.height).toBe(size);
    await expectBrandColors(image);
  });
});
