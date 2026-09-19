import { createHash } from "node:crypto";
import sharp from "sharp";

// The files this node serves for one uploaded image, made once, at upload.
// Nothing is resized on request: stored renditions need no image service, so
// the node runs the same on any host. Spec: listing-schema.md §Media.
//
//   original   full resolution — what the `media_original` field group unlocks
//   derived    what every other partner is given as `url`
//   thumbnail  the small rendition behind `thumbnail_url`
//
// No "server-only" marker: these are pure functions of their input, and the
// unit lane runs them.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Long edge of the derived rendition, in pixels. */
export const DERIVED_EDGE = 1920;
/** Long edge of the thumbnail. The spec mandates no size and suggests 400–640 px. */
export const THUMBNAIL_EDGE = 480;

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);
// Decoding is where an image costs memory, and the pixel count — not the file
// size — is what decides how much. A small file can declare enormous dimensions.
const MAX_INPUT_PIXELS = 100_000_000;

export class MediaError extends Error {}

export interface Rendition {
  bytes: Buffer;
  /** Of exactly these bytes: what a partner verifies its download against. */
  sha256: string;
  width: number;
  height: number;
  contentType: "image/jpeg";
}

export interface Renditions {
  original: Rendition;
  derived: Rendition;
  thumbnail: Rendition;
}

export const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function render(input: Buffer, edge: number | null, quality: number): Promise<Rendition> {
  let pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    // Apply the camera's orientation to the pixels: the tag that carries it is
    // about to be dropped with the rest of the metadata.
    .autoOrient();
  if (edge !== null) pipeline = pipeline.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
  const { data, info } = await pipeline
    // JPEG has no transparency; a deck plan drawn on a clear background goes onto white, not black.
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: quality >= 90 ? "4:4:4" : "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, sha256: sha256Hex(data), width: info.width, height: info.height, contentType: "image/jpeg" };
}

/**
 * Every rendition is re-encoded, the original included, and sharp writes no
 * metadata unless asked to. That is deliberate: a photograph taken aboard
 * carries the GPS position it was taken at, and serving it would hand every
 * partner the berth that the `location_exact` field group exists to withhold.
 */
export async function renderImage(input: Buffer): Promise<Renditions> {
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new MediaError(`An image can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

  // What the file is, is read from the file. Its name and the content type the
  // browser claimed for it are not evidence.
  let format: string | undefined;
  try {
    ({ format } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata());
  } catch {
    throw new MediaError("That file is not an image this node can read. Upload a JPEG, PNG or WebP.");
  }
  if (format === undefined || !ACCEPTED_FORMATS.has(format)) throw new MediaError("Upload a JPEG, PNG or WebP image.");

  try {
    const [original, derived, thumbnail] = await Promise.all([
      render(input, null, 92),
      render(input, DERIVED_EDGE, 82),
      render(input, THUMBNAIL_EDGE, 78),
    ]);
    return { original, derived, thumbnail };
  } catch {
    throw new MediaError("That image is damaged or too large to process.");
  }
}
