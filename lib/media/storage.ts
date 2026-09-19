import "server-only";
import type { MediaUrls } from "@/lib/listings/own-listing-row";
import { supabaseUrl } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";

// Where listing files live. Three buckets, created by the listing_media
// migration, which also says who may write to them.
export const SERVED_BUCKET = "listing-media";
export const ORIGINALS_BUCKET = "listing-originals";
export const UPLOADS_BUCKET = "listing-uploads";

// The spec asks for originals to be served from expiring URLs and does not say
// for how long. A partner fetches media soon after a sync, so a week is
// generous; one that needs the file later dereferences the listing's canonical
// URI and is given a fresh URL. A new URL is not a change to the listing, so
// `updated_at` does not move when one is minted.
const ORIGINAL_URL_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Plain HTTPS, no signature, a path nobody can guess: a partner's website can embed it. */
export const servedUrl = (path: string) =>
  `${supabaseUrl()}/storage/v1/object/public/${SERVED_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** URLs for a page of listings, originals included: one signing request for the lot. */
export async function mediaUrlsWithOriginals(originalPaths: string[]): Promise<MediaUrls> {
  const signed = new Map<string, string>();
  if (originalPaths.length > 0) {
    // Service role: the caller is a partner node, authenticated by its signature.
    const { data, error } = await serviceClient().storage.from(ORIGINALS_BUCKET).createSignedUrls(originalPaths, ORIGINAL_URL_LIFETIME_SECONDS);
    // Not fatal: without a URL for an original the listing is served with its
    // derived rendition, which is a complete and truthful listing.
    if (error) console.error(`[openyacht] cannot sign URLs for originals: ${error.message}`);
    for (const entry of data ?? []) if (entry.path && entry.signedUrl && !entry.error) signed.set(entry.path, entry.signedUrl);
  }
  return { served: servedUrl, original: (path) => signed.get(path) ?? null };
}

/** For a partner without `media_original`, and for this node's own screens: no originals, nothing to sign. */
export const mediaUrls: MediaUrls = { served: servedUrl, original: () => null };
