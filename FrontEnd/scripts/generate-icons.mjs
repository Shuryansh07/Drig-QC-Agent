/**
 * Renders the PWA icon set from public/icons/icon.svg.
 * Run after changing the mark: `pnpm icons`.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "public/icons/icon.svg"));

const targets = [
  { file: "icon-192.png", size: 192, padding: 0 },
  { file: "icon-512.png", size: 512, padding: 0 },
  // Maskable icons are cropped to a safe zone, so the mark is inset by 10%.
  { file: "icon-512-maskable.png", size: 512, padding: 0.1 },
  { file: "apple-touch-icon.png", size: 180, padding: 0 },
];

for (const { file, size, padding } of targets) {
  const inner = Math.round(size * (1 - padding * 2));
  const offset = Math.round((size - inner) / 2);

  const mark = await sharp(source).resize(inner, inner).png().toBuffer();
  const out = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 11, g: 47, b: 92, alpha: 1 },
    },
  })
    .composite([{ input: mark, top: offset, left: offset }])
    .png()
    .toBuffer();

  await writeFile(path.join(root, "public/icons", file), out);
  console.log(`wrote public/icons/${file} (${size}px)`);
}
