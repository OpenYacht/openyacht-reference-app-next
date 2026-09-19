import type { OwnListing } from "@/federation";

// A listing as the database holds it, and the mapping to what the federation
// core serialises. No "server-only" marker here: it is a pure function, and the
// unit lane runs it.

export interface VesselRow {
  hin: string | null;
  imo: string | null;
  mmsi: string | null;
  official_number: string | null;
  builder_name: string | null;
  builder_slug: string | null;
  model_name: string | null;
  model_slug: string | null;
  year_built: number | null;
  refit_year: number | null;
  /** `numeric` arrives from Postgres as a string. */
  loa_m: string | number | null;
  previous_names: string[];
}

export interface ListingRow {
  uuid: string;
  listing_type: "sale" | "charter";
  status: OwnListing["status"];
  name: string;
  summary: string | null;
  condition: OwnListing["condition"];
  agreement_type: "central" | "exclusive" | "open" | null;
  co_brokerage: boolean | null;
  price_amount: string | null;
  price_currency: string | null;
  price_on_application: boolean;
  price_starting: boolean;
  location_display: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  location_marina: string | null;
  location_lat: number | null;
  location_lon: number | null;
  brokers: OwnListing["brokers"];
  specifications: OwnListing["specifications"];
  descriptions: OwnListing["descriptions"];
  features: OwnListing["features"];
  media: StoredMedia;
  charter: OwnListing["charter"];
  usage: OwnListing["usage"];
  compliance: OwnListing["compliance"];
  listed_at: string | Date | null;
  federation_updated_at: string | Date;
}

/**
 * An image as the `media` column holds it: where its files are, never what
 * their URLs are. A URL depends on where the node is deployed and, for an
 * original, on when it was asked for — so URLs are made when a listing is
 * served. `sha256`, `width` and `height` describe the derived rendition;
 * `original` describes the full-resolution file separately, because a partner
 * verifies the bytes it was actually given.
 */
export interface StoredImage {
  id: string;
  path: string;
  thumbnail_path: string;
  sha256: string;
  width: number;
  height: number;
  caption?: string | null;
  category?: "exterior" | "interior" | "lifestyle" | "crew" | null;
  sort?: number;
  original?: { path: string; sha256: string; width: number; height: number } | null;
}

/** A link to a video or a tour hosted elsewhere: a URL of its own, and no hash (the file is not this node's). */
export interface StoredLink {
  id: string;
  url: string;
  caption?: string | null;
  sort: number;
}

export interface StoredDocument {
  id: string;
  path: string;
  sha256: string;
  caption?: string | null;
  sort: number;
}

export interface StoredMedia {
  profile?: StoredImage | null;
  gallery?: StoredImage[];
  layouts?: StoredImage[];
  videos?: StoredLink[];
  tours?: StoredLink[];
  documents?: StoredDocument[];
}

/** How stored paths become URLs. The host supplies it; tests fake it. */
export interface MediaUrls {
  /** The plain HTTPS URL of a file in the public bucket. */
  served(path: string): string;
  /** A URL for a full-resolution original, or null when none was made for this request. */
  original(path: string): string | null;
}

/** The paths of every original a page of listings holds: what to mint URLs for, in one request. */
export const originalPaths = (media: StoredMedia): string[] =>
  [media.profile, ...(media.gallery ?? []), ...(media.layouts ?? [])].flatMap((image) => (image?.original ? [image.original.path] : []));

/** Every file behind a media block, by bucket: what to remove when the item, or the listing, goes. */
export function storedFiles(media: StoredMedia): { served: string[]; originals: string[] } {
  const images = [media.profile, ...(media.gallery ?? []), ...(media.layouts ?? [])].filter((image) => image !== null && image !== undefined);
  return {
    served: [...images.flatMap((image) => [image.path, image.thumbnail_path]), ...(media.documents ?? []).map((document) => document.path)],
    originals: originalPaths(media),
  };
}

// Only what belongs on the wire is carried across: the node's own bookkeeping
// (`id`, the paths) stays behind.
function toMedia(media: StoredMedia, urls: MediaUrls): OwnListing["media"] {
  const image = (item: StoredImage) => {
    const originalUrl = item.original ? urls.original(item.original.path) : null;
    return {
      url: urls.served(item.path),
      // Always this node's own rendition of the same image (LS-16).
      thumbnail_url: urls.served(item.thumbnail_path),
      sha256: item.sha256,
      width: item.width,
      height: item.height,
      caption: item.caption ?? null,
      original:
        item.original && originalUrl !== null
          ? { url: originalUrl, sha256: item.original.sha256, width: item.original.width, height: item.original.height }
          : null,
    };
  };
  const sort = (item: { sort?: number }, index: number) => item.sort ?? index + 1;
  // `sha256` stays null for a link: the file is on someone else's platform.
  const link = (item: StoredLink, index: number) => ({ url: item.url, caption: item.caption ?? null, sort: sort(item, index) });
  return {
    profile: media.profile ? image(media.profile) : null,
    gallery: (media.gallery ?? []).map((item, index) => ({ ...image(item), category: item.category ?? null, sort: sort(item, index) })),
    layouts: (media.layouts ?? []).map((item, index) => ({ ...image(item), sort: sort(item, index) })),
    videos: (media.videos ?? []).map(link),
    tours: (media.tours ?? []).map(link),
    documents: (media.documents ?? []).map((item, index) => ({
      url: urls.served(item.path),
      sha256: item.sha256,
      caption: item.caption ?? null,
      sort: sort(item, index),
    })),
  };
}

export interface PriceHistoryRow {
  id: number;
  amount: string;
  currency: string;
  changed_at: string | Date;
}

const wireTimestamp = (value: string | Date) => `${new Date(value).toISOString().slice(0, 19)}Z`;
const vocab = (name: string | null, slug: string | null) => (name === null ? null : { name, slug });

export function toOwnListing(row: ListingRow, vessel: VesselRow, priceHistory: PriceHistoryRow[], urls: MediaUrls): OwnListing {
  const hasAgreement = row.agreement_type !== null || row.co_brokerage !== null;
  return {
    uuid: row.uuid,
    type: row.listing_type,
    status: row.status,
    updatedAt: new Date(row.federation_updated_at),
    listedAt: row.listed_at === null ? null : new Date(row.listed_at),
    condition: row.condition,
    agreement: hasAgreement ? { type: row.agreement_type, co_brokerage: row.co_brokerage } : null,
    vessel: {
      hin: vessel.hin,
      imo: vessel.imo,
      mmsi: vessel.mmsi,
      official_number: vessel.official_number,
      builder: vocab(vessel.builder_name, vessel.builder_slug),
      model: vocab(vessel.model_name, vessel.model_slug),
      year_built: vessel.year_built,
      refit_year: vessel.refit_year,
      // Units are canonical metric and a JSON number on the wire (LS-2).
      loa_m: vessel.loa_m === null ? null : Number(vessel.loa_m),
      previous_names: vessel.previous_names,
    },
    name: row.name,
    summary: row.summary,
    price:
      row.listing_type === "charter"
        ? null
        : { amount: row.price_amount, currency: row.price_currency, on_application: row.price_on_application, starting_price: row.price_starting },
    // Newest first, decided here at the database's precision. Wire timestamps
    // are whole seconds, so two changes inside one second tie once truncated —
    // and the serialiser, sorting ties stably, keeps the order given to it.
    priceHistory: [...priceHistory]
      .sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime() || b.id - a.id)
      .map((entry) => ({ amount: entry.amount, currency: entry.currency, changed_at: wireTimestamp(entry.changed_at) })),
    location:
      row.location_display === null
        ? null
        : {
            display: row.location_display,
            city: row.location_city,
            state: row.location_state,
            country: row.location_country,
            marina: row.location_marina,
            coordinates: row.location_lat === null || row.location_lon === null ? null : { lat: row.location_lat, lon: row.location_lon },
          },
    brokers: row.brokers,
    specifications: row.specifications,
    descriptions: row.descriptions,
    features: row.features,
    media: toMedia(row.media, urls),
    charter: row.charter,
    usage: row.usage,
    compliance: row.compliance,
  };
}
