import sharp from 'sharp';
import { MIN_SIDE_PX, PHOTO_VARIANTS, UPLOAD_TYPES } from '../bo/photo.js';
import { AppError } from '../exception/app-error.js';

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
}

const FORMATS: Record<string, (typeof UPLOAD_TYPES)[number]> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// A small file can still decode to a huge picture. Refuse those before they use the memory.
const MAX_PIXELS = 40_000_000;

/**
 * Turns an uploaded file into the two images that are stored, or refuses it.
 *
 * The file's own bytes decide what it is, never its name or the type the browser claimed. The
 * picture is decoded and written out again as WebP, which removes everything that was not
 * pixels: location and camera details (EXIF), embedded profiles and anything hidden after the
 * image data. The photo's orientation is applied first, so it still looks right.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const open = () =>
    sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true });

  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const meta = await open().metadata();
    format = meta.format;
    // An EXIF rotation swaps which side is the width.
    const turned = (meta.orientation ?? 1) >= 5;
    width = (turned ? meta.height : meta.width) ?? 0;
    height = (turned ? meta.width : meta.height) ?? 0;
  } catch {
    throw new AppError(422, 'PHOTO_INVALID');
  }
  if (!format || !FORMATS[format]) throw new AppError(415, 'PHOTO_TYPE_UNSUPPORTED');
  if (Math.min(width, height) < MIN_SIDE_PX) throw new AppError(422, 'PHOTO_TOO_SMALL');

  try {
    const make = (variant: keyof typeof PHOTO_VARIANTS) =>
      open()
        .rotate()
        .resize({
          width: PHOTO_VARIANTS[variant].maxSide,
          height: PHOTO_VARIANTS[variant].maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: PHOTO_VARIANTS[variant].quality })
        .toBuffer();
    const [full, thumb] = await Promise.all([make('full'), make('thumb')]);
    return { full, thumb };
  } catch {
    // A file with a valid header but damaged picture data fails here.
    throw new AppError(422, 'PHOTO_INVALID');
  }
}

const SITE_IMAGE_MAX_SIDE = 1920;
const SITE_IMAGE_MIN_SIDE = 200;

/**
 * A picture for the public home page (hero, about, gallery): decoded and written again as a WebP of at
 * most 1920 pixels on the longest side, turned upright, with no metadata (a phone photo's location is
 * dropped). The file's own bytes decide what it is; an SVG is refused.
 */
export async function processSiteImage(input: Buffer): Promise<Buffer> {
  const open = () =>
    sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true });
  let format: string | undefined;
  let size = 0;
  try {
    const meta = await open().metadata();
    format = meta.format;
    size = Math.min(meta.width ?? 0, meta.height ?? 0);
  } catch {
    throw new AppError(422, 'IMAGE_INVALID');
  }
  if (!format || !FORMATS[format]) throw new AppError(415, 'IMAGE_TYPE_UNSUPPORTED');
  if (size < SITE_IMAGE_MIN_SIDE) throw new AppError(422, 'IMAGE_TOO_SMALL');
  try {
    return await open()
      .rotate()
      .resize({
        width: SITE_IMAGE_MAX_SIDE,
        height: SITE_IMAGE_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AppError(422, 'IMAGE_INVALID');
  }
}

const LOGO_MAX_SIDE = 512;
const LOGO_MIN_SIDE = 32;

/**
 * An agency's logo: decoded and written again as a WebP that fits in 512 by 512 pixels, keeping any
 * transparency. Like a photo, the file's own bytes decide what it is, and nothing but pixels is kept
 * (an SVG, which can carry script, is refused as an unsupported type).
 */
export async function processLogo(input: Buffer): Promise<Buffer> {
  const open = () =>
    sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true });
  let format: string | undefined;
  let size = 0;
  try {
    const meta = await open().metadata();
    format = meta.format;
    size = Math.min(meta.width ?? 0, meta.height ?? 0);
  } catch {
    throw new AppError(422, 'LOGO_INVALID');
  }
  if (!format || !FORMATS[format]) throw new AppError(415, 'LOGO_TYPE_UNSUPPORTED');
  if (size < LOGO_MIN_SIDE) throw new AppError(422, 'LOGO_TOO_SMALL');
  try {
    return await open()
      .rotate()
      .resize({
        width: LOGO_MAX_SIDE,
        height: LOGO_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throw new AppError(422, 'LOGO_INVALID');
  }
}

/**
 * The widths a public picture may be asked for (`?w=320`), so a thumbnail does not download the full picture.
 * A fixed list keeps the number of different files small (they are cached and shared) and keeps anyone from
 * making the server resize to thousands of odd sizes.
 */
export const IMAGE_WIDTHS = [160, 320, 640, 960, 1280] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export function isImageWidth(value: number): value is ImageWidth {
  return (IMAGE_WIDTHS as readonly number[]).includes(value);
}

const RESIZED_MAX_ENTRIES = 300;
const resized = new Map<string, Buffer>();

/**
 * A smaller copy of an already stored (WebP) site picture, never larger than the original and with the same
 * transparency. The copies are kept in memory (the newest 300) because the pictures never change under the same
 * file name, so a busy page does not make the server resize again for every visitor.
 */
export async function resizedImage(key: string, bytes: Buffer, width: ImageWidth): Promise<Buffer> {
  const id = `${key}@${width}`;
  const hit = resized.get(id);
  if (hit) {
    // Newest at the end, so the oldest is the one dropped when the memory is full.
    resized.delete(id);
    resized.set(id, hit);
    return hit;
  }
  let out: Buffer;
  try {
    out = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new AppError(422, 'IMAGE_INVALID');
  }
  resized.set(id, out);
  if (resized.size > RESIZED_MAX_ENTRIES) resized.delete(resized.keys().next().value as string);
  return out;
}
