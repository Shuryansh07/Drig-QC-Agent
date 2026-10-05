import { createCanvas, loadImage } from "@napi-rs/canvas";
import { logger } from "../../utils/logger.js";

/**
 * OpenAI vision models shrink every image to fit 2048x2048 and then to a 768px
 * SHORT side before reading it. A whole wiring drawing therefore reaches the model
 * at roughly 1000x768, where "PUR 16 GA" printed in 6pt type is a smudge. Sending
 * the page as overlapping zoomed tiles as well as whole lets each label arrive at
 * two to three times the resolution, while the whole page still shows the layout
 * (which line goes where).
 */

// Overlap so a label cut by a tile edge appears whole in the neighbouring tile.
const OVERLAP = 0.08;
// Below this the whole image already reaches the model at full resolution; tiling adds cost, not detail.
const MIN_SHORT_SIDE_FOR_TILES = 1000;

/**
 * @param {Buffer} buffer a PNG or JPEG (anything @napi-rs/canvas can decode)
 * @param {{ grid?: number }} [options] tiles per side; 2 gives four quadrants
 * @returns {Promise<{ buffer: Buffer, mimeType: string, label: string }[]>}
 *   The whole image first, then the tiles left-to-right, top-to-bottom. An image
 *   that cannot be decoded (or is small) comes back alone, never as an error.
 */
export const toVisionImages = async (buffer, mimeType, { grid = 2 } = {}) => {
  const whole = { buffer, mimeType, label: "whole page" };
  if (grid < 2) return [whole];

  let image;
  try {
    image = await loadImage(buffer);
  } catch (err) {
    logger.warn(`[vision] could not decode ${mimeType} for tiling; sending it whole only (${err.message})`);
    return [whole];
  }

  const { width, height } = image;
  if (Math.min(width, height) < MIN_SHORT_SIDE_FOR_TILES) return [whole];

  const tileW = Math.ceil((width / grid) * (1 + OVERLAP));
  const tileH = Math.ceil((height / grid) * (1 + OVERLAP));
  const rowNames = grid === 2 ? ["top", "bottom"] : null;
  const colNames = grid === 2 ? ["left", "right"] : null;

  const tiles = [];
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      // Evenly spread: the first tile starts at the left/top edge, the last ends at the right/bottom edge.
      const sx = Math.round(((width - tileW) * col) / (grid - 1));
      const sy = Math.round(((height - tileH) * row) / (grid - 1));

      const canvas = createCanvas(tileW, tileH);
      canvas.getContext("2d").drawImage(image, sx, sy, tileW, tileH, 0, 0, tileW, tileH);
      tiles.push({
        buffer: await canvas.encode("png"),
        mimeType: "image/png",
        label: rowNames ? `zoomed ${rowNames[row]}-${colNames[col]} quarter` : `zoomed tile row ${row + 1}, column ${col + 1}`,
      });
    }
  }

  return [whole, ...tiles];
};

/** OpenAI chat content parts for `images`, each preceded by its label so the model knows what it is looking at. */
export const visionContentParts = (images) =>
  images.flatMap((img) => [
    { type: "text", text: `[${img.label}]` },
    { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.buffer.toString("base64")}`, detail: "high" } },
  ]);
