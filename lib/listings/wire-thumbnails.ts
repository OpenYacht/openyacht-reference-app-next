// Previews of a partner listing's media, taken from the thumbnails the
// authority serves for exactly this purpose (listing-schema.md §Media, LS-16):
// small renditions for listing pickers and curation screens, so a consumer can
// show what it holds before running an image pipeline of its own.
//
// Inbound URLs are untrusted (FP-14). Only an absolute https URL without
// credentials is handed to a page, and only a thumbnail: the full-resolution
// `url` is never embedded here. Sizes derived from it are this node's own
// renditions, which are a separate, cached step.

export interface Thumbnail {
  src: string;
  caption: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
}

function thumbnail(item: unknown): Thumbnail | null {
  if (!isRecord(item)) return null;
  const src = httpsUrl(item.thumbnail_url);
  return src === null ? null : { src, caption: text(item.caption) };
}

function media(payload: unknown): Record<string, unknown> {
  return isRecord(payload) && isRecord(payload.media) ? payload.media : {};
}

/** The authority's chosen hero image (`profile` is never "the first gallery item"). */
export function profileThumbnail(payload: unknown): Thumbnail | null {
  return thumbnail(media(payload).profile);
}

export interface ThumbnailSet {
  thumbnails: Thumbnail[];
  /** Items the authority serves no thumbnail for: they get a preview only once this node has made its own. */
  withoutPreview: number;
}

/** A gallery or layouts collection, in the authority's `sort` order. */
export function collectionThumbnails(payload: unknown, collection: "gallery" | "layouts"): ThumbnailSet {
  const items = media(payload)[collection];
  const list = Array.isArray(items) ? items.filter(isRecord) : [];
  const sorted = [...list].sort((a, b) => (typeof a.sort === "number" ? a.sort : 0) - (typeof b.sort === "number" ? b.sort : 0));
  const thumbnails = sorted.map(thumbnail).filter((item): item is Thumbnail => item !== null);
  return { thumbnails, withoutPreview: list.length - thumbnails.length };
}
