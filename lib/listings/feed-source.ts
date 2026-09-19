import "server-only";
import {
  ListingError,
  parseNodeIdentity,
  serializeListing,
  serializeTombstone,
  type FeedPosition,
  type FeedQuery,
  type FieldGroup,
  type ListingFeedSource,
  type OpenYachtListing,
  type ServedItem,
} from "@/federation";
import { mediaUrls, mediaUrlsWithOriginals } from "@/lib/media/storage";
import { serviceClient } from "@/lib/supabase/service";
import { originalPaths, toOwnListing, type ListingRow, type MediaUrls, type PriceHistoryRow, type VesselRow } from "./own-listing-row";

// The partner feed over Supabase. Service role throughout: the caller is a
// partner node, already authenticated by its signature. Which listings it may
// see is decided inside the database (feed_for_partner, listing_for_partner);
// which fields, by the partner's field groups, applied while serialising.

const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

interface FeedRow {
  listing_id: number;
  listing_uuid: string;
  effective_at: string;
  kind: "listing" | "tombstone";
  tombstone_status: "sold" | "withdrawn" | null;
  tombstone_at: string | null;
}

type StoredListing = ListingRow & { id: number; vessels: VesselRow; price_history: PriceHistoryRow[] };

async function partnerByDomain(domain: string): Promise<{ id: number; grants: Set<FieldGroup> } | null> {
  const { data, error } = await serviceClient().from("federation_partners").select("id, field_groups").eq("domain", domain).maybeSingle();
  if (error) throw new Error(`Cannot read the partner: ${error.message}`);
  return data === null ? null : { id: data.id, grants: new Set(data.field_groups as FieldGroup[]) };
}

async function loadListings(ids: number[]): Promise<Map<number, StoredListing>> {
  if (ids.length === 0) return new Map();
  // One query for the page, not one per listing.
  const { data, error } = await serviceClient()
    .from("listings")
    .select("*, vessels(*), price_history(id, amount, currency, changed_at)")
    .in("id", ids);
  if (error) throw new Error(`Cannot read listings: ${error.message}`);
  return new Map((data as StoredListing[]).map((row) => [row.id, row]));
}

const serve = (row: StoredListing, domain: string, grants: Set<FieldGroup>, urls: MediaUrls): OpenYachtListing =>
  serializeListing(toOwnListing(row, row.vessels, row.price_history, urls), { domain, grants });

/** Originals are private files: URLs for them are minted only for a partner granted `media_original`, one request per page. */
const urlsFor = (rows: StoredListing[], grants: Set<FieldGroup>): Promise<MediaUrls> =>
  grants.has("media_original") ? mediaUrlsWithOriginals(rows.flatMap((row) => originalPaths(row.media))) : Promise.resolve(mediaUrls);

/**
 * For a feed page: one listing that cannot be serialised must not take the
 * partner's whole feed down with it. It is left out, and said so loudly —
 * the partner keeps syncing everything else while the listing is fixed.
 */
function serveOrSkip(row: StoredListing, domain: string, grants: Set<FieldGroup>, urls: MediaUrls): OpenYachtListing | null {
  try {
    return serve(row, domain, grants, urls);
  } catch (error) {
    if (!(error instanceof ListingError)) throw error;
    console.error(`[openyacht] listing ${row.uuid} left out of the feed: ${error.message}`);
    return null;
  }
}

export const supabaseFeedSource: ListingFeedSource = {
  async page(partnerDomain: string, query: FeedQuery) {
    const { domain } = parseNodeIdentity(process.env);
    const partner = await partnerByDomain(partnerDomain);
    if (partner === null) return { items: [], next: null };

    // One row more than asked for: its presence is how the last page is recognised.
    const { data, error } = await serviceClient().rpc("feed_for_partner", {
      p_partner_id: partner.id,
      p_since: query.since,
      p_after_at: query.after?.at ?? null,
      p_after_id: query.after?.id ?? null,
      p_limit: query.pageSize + 1,
    });
    if (error) throw new Error(`Cannot read the feed: ${error.message}`);

    const rows = (data as FeedRow[]).slice(0, query.pageSize);
    const hasMore = (data as FeedRow[]).length > query.pageSize;
    const stored = await loadListings(rows.filter((row) => row.kind === "listing").map((row) => row.listing_id));

    const urls = await urlsFor([...stored.values()], partner.grants);

    const items: ServedItem[] = [];
    for (const row of rows) {
      const listing = stored.get(row.listing_id);
      if (row.kind === "listing" && listing !== undefined) {
        const item = serveOrSkip(listing, domain, partner.grants, urls);
        if (item !== null) items.push(item);
      } else if (row.kind === "tombstone")
        items.push(serializeTombstone(domain, row.listing_uuid, row.tombstone_status ?? "withdrawn", new Date(row.tombstone_at ?? row.effective_at)));
    }
    const last = rows.at(-1);
    const next: FeedPosition | null = hasMore && last !== undefined ? { at: last.effective_at, id: String(last.listing_id) } : null;
    return { items, next };
  },

  async one(partnerDomain: string, uuid: string) {
    const { domain } = parseNodeIdentity(process.env);
    const partner = await partnerByDomain(partnerDomain);
    if (partner === null) return null;

    const { data: id, error } = await serviceClient().rpc("listing_for_partner", { p_partner_id: partner.id, p_uuid: uuid });
    if (error) throw new Error(`Cannot resolve the listing: ${error.message}`);
    if (id === null) return null;

    const listing = (await loadListings([id as number])).get(id as number);
    if (listing === undefined) return null;
    // Ended listings stay dereferenceable for twelve months, so a partner's
    // clean-up does not meet a 404; after that, 410 Gone.
    const ended = listing.status === "sold" || listing.status === "withdrawn";
    if (ended && Date.now() - new Date(listing.federation_updated_at).getTime() > RETENTION_MS) return "gone";
    return serve(listing, domain, partner.grants, await urlsFor([listing], partner.grants));
  },
};
