import sharp from 'sharp';

/**
 * What another member is allowed to see of a photo (21 October 2026).
 *
 * - `blurPreview` makes a picture nobody can recognise: it keeps only the colours and the shape of the
 *   photo. It is made from the small stored copy, so the clear picture is never decoded for it.
 * - `watermark` writes the viewer's member code across a clear photo, so a copy that is passed on can be
 *   traced to who saw it. The letters are drawn as lines, not text, so it looks the same on any server (no fonts needed).
 */

const SEGMENTS: Record<string, string> = {
  // Seven-segment digits on a 6 by 10 box, as line paths.
  '0': 'M0,0 L6,0 L6,10 L0,10 Z',
  '1': 'M6,0 L6,10',
  '2': 'M0,0 L6,0 L6,5 L0,5 L0,10 L6,10',
  '3': 'M0,0 L6,0 L6,10 L0,10 M0,5 L6,5',
  '4': 'M0,0 L0,5 L6,5 M6,0 L6,10',
  '5': 'M6,0 L0,0 L0,5 L6,5 L6,10 L0,10',
  '6': 'M6,0 L0,0 L0,10 L6,10 L6,5 L0,5',
  '7': 'M0,0 L6,0 L6,10',
  '8': 'M0,0 L6,0 L6,10 L0,10 Z M0,5 L6,5',
  '9': 'M6,5 L0,5 L0,0 L6,0 L6,10 L0,10',
  M: 'M0,10 L0,0 L3,6 L6,0 L6,10',
};

/** The code as one SVG path, glyphs side by side, 6 units wide with a 3 unit gap. */
function codePath(code: string): { path: string; width: number } {
  let x = 0;
  const parts: string[] = [];
  for (const char of code.toUpperCase()) {
    const glyph = SEGMENTS[char];
    if (!glyph) continue;
    parts.push(`<path transform="translate(${x} 0)" d="${glyph}"/>`);
    x += 9;
  }
  return { path: parts.join(''), width: Math.max(x - 3, 1) };
}

/** A tiny, soft picture: colour and shape only. */
export async function blurPreview(thumb: Buffer): Promise<Buffer> {
  const small = await sharp(thumb)
    .rotate()
    .resize({ width: 24, height: 30, fit: 'inside' })
    .toBuffer();
  return sharp(small)
    .resize({ width: 240, height: 300, fit: 'inside', kernel: 'cubic' })
    .blur(8)
    .webp({ quality: 55 })
    .toBuffer();
}

/**
 * The picture of a card on the public site: 80 per cent blurred, 20 per cent visible. A very soft base (colour and
 * shape only) with a slightly less soft layer laid over it at 20 per cent, so a visitor sees there is a person, the
 * colour of their clothes and the mood of the picture, but cannot recognise a face. It is made from the small stored
 * copy, so the clear picture is never decoded for it, and it is cropped to 4 by 5 like the card.
 */
export async function showcaseBlur(thumb: Buffer): Promise<Buffer> {
  const upright = await sharp(thumb).rotate().toBuffer();
  const crop = { width: 16, height: 20, fit: 'cover' as const, position: 'attention' as const };
  const base = await sharp(upright)
    .resize({ width: 8, height: 10, fit: 'cover' })
    .resize({ width: 240, height: 300, kernel: 'cubic' })
    .blur(16)
    .toBuffer();
  const soft = await sharp(upright)
    .resize(crop)
    .resize({ width: 240, height: 300, kernel: 'cubic' })
    .blur(10)
    .ensureAlpha(0.2)
    .png()
    .toBuffer();
  return sharp(base)
    .composite([{ input: soft }])
    .webp({ quality: 55 })
    .toBuffer();
}

/** The viewer's member code, repeated across the picture in two layers so it shows on light and dark photos. */
export async function watermark(image: Buffer, code: string): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 400;
  const height = meta.height ?? 500;
  const { path, width: units } = codePath(code);
  // The code spans about half the picture's width; rows are spaced down the picture and turned slightly.
  const scale = (width * 0.5) / units;
  const rows = Math.max(2, Math.round(height / (scale * 10 * 3.2)));
  const spacing = height / rows;
  const lines = Array.from({ length: rows }, (_, row) => {
    const y = spacing * (row + 0.5) - 5 * scale;
    const x = (width - units * scale) / 2 + (row % 2 === 0 ? -width * 0.06 : width * 0.06);
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})">${path}</g>`;
  }).join('');
  const stroke = Math.max(1.2, 1.6 / Math.max(scale, 0.5));
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="rotate(-24 ${width / 2} ${height / 2})" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<g stroke="#000" stroke-opacity="0.28" stroke-width="${(stroke * 2.4).toFixed(2)}">${lines}</g>` +
      `<g stroke="#fff" stroke-opacity="0.55" stroke-width="${stroke.toFixed(2)}">${lines}</g>` +
      `</g></svg>`,
  );
  return sharp(image)
    .composite([{ input: svg }])
    .webp({ quality: 82 })
    .toBuffer();
}
