import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { blurPreview, watermark } from '../src/security/photo-view.js';

/** A picture with detail: stripes and a circle, so a blur or a mark can be told from the original. */
async function picture() {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">` +
      Array.from(
        { length: 25 },
        (_, i) => `<rect x="${i * 16}" y="0" width="8" height="500" fill="#3a5f8a"/>`,
      ).join('') +
      `<circle cx="200" cy="200" r="90" fill="#e0b080"/></svg>`,
  );
  return sharp(svg).webp({ quality: 85 }).toBuffer();
}

const pixels = async (image: Buffer) =>
  (await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;

await test('a blurred preview is a small WebP that keeps colour but not detail', async () => {
  const original = await picture();
  const blurred = await blurPreview(original);
  const meta = await sharp(blurred).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok((meta.width ?? 0) <= 240 && (meta.height ?? 0) <= 300);
  // The stripes (high detail) are gone: neighbouring pixels differ little.
  const data = await pixels(blurred);
  let jump = 0;
  for (let i = 3; i < data.length; i += 3) jump = Math.max(jump, Math.abs(data[i]! - data[i - 3]!));
  assert.ok(jump < 40, `largest jump between neighbouring pixels was ${jump}`);
});

await test('a watermark keeps the size and changes the picture, and a different code changes it differently', async () => {
  const original = await picture();
  const a = await watermark(original, 'M3401788');
  const b = await watermark(original, 'M1083814');
  const [metaO, metaA] = await Promise.all([sharp(original).metadata(), sharp(a).metadata()]);
  assert.equal(metaA.width, metaO.width);
  assert.equal(metaA.height, metaO.height);
  const [po, pa, pb] = await Promise.all([pixels(original), pixels(a), pixels(b)]);
  const differs = (x: Buffer, y: Buffer) => x.some((value, i) => Math.abs(value - y[i]!) > 12);
  assert.ok(differs(po, pa), 'the mark is visible');
  assert.ok(differs(pa, pb), 'the code decides what is drawn');
});

await test('an unknown character in the code is skipped rather than failing', async () => {
  const original = await picture();
  const out = await watermark(original, 'M12-34?');
  assert.equal((await sharp(out).metadata()).format, 'webp');
});
