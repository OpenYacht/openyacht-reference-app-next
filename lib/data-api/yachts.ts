import "server-only";
import { FIELD_GROUPS, ListingError, parseNodeIdentity, partnerFreshness, serializeListing, type FieldGroup } from "@/federation";
import { originalPaths, toOwnListing, type ListingRow, type PriceHistoryRow, type VesselRow } from "@/lib/listings/own-listing-row";
import { mediaUrlsWithOriginals } from "@/lib/media/storage";
import { serviceClient } from "@/lib/supabase/service";

// Every yacht this node displays, for its own websites and feeds: its own
// active listings and the partner listings it displays, each a complete
// document in the protocol's wire shape. What a website needs beyond the wire
// rides along as x_-prefixed extension fields, the protocol's own mechanism
// (listing-schema.md §Conventions): x_key, x_source, x_provenance,
// x_attribution_text.
//
// Service role throughout: the caller is authenticated by API key, not as a
// signed-in user. Which partner listings count as displayed is the same rule
// the admin screens apply: published, no unreviewed vessel conflict (ID-9),
// and a partner not hidden for staleness (FP-15) — a vanished authority can
// no longer withdraw its own listings, so they are not served as current.

export type Source = "all" | "own" | "imported";
export type YachtItem = Record<string, unknown> & { x_key: string; x_source: "own" | "imported" };

type StoredListing = ListingRow & { id: number; vessels: VesselRow; price_history: PriceHistoryRow[] };
const ALL_GROUPS = new Set<FieldGroup>(FIELD_GROUPS);
const OWN_COLUMNS = "*, vessels(*), price_history(id, amount, currency, changed_at)";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const importedKey = (canonicalUri: string) => `imported-${Buffer.from(canonicalUri, "utf8").toString("base64url")}`;

/** This node's own data, for its own consumer: every field group, originals included as expiring URLs. */
async function ownItems(rows: StoredListing[]): Promise<YachtItem[]> {
  const { domain } = parseNodeIdentity(process.env);
  const urls = await mediaUrlsWithOriginals(rows.flatMap((row) => originalPaths(row.media)));
  const items: YachtItem[] = [];
  for (const row of rows) {
    try {
      const document = serializeListing(toOwnListing(row, row.vessels, row.price_history, urls), { domain, grants: ALL_GROUPS });
      items.push({
        ...(document as unknown as Record<string, unknown>),
        x_key: row.uuid,
        x_source: "own",
        x_provenance: null,
        x_attribution_text: null,
      });
    } catch (error) {
      // One listing that cannot be serialised must not take the feed down.
      if (!(error instanceof ListingError)) throw error;
      console.error(`[openyacht] listing ${row.uuid} left out of the data API: ${error.message}`);
    }
  }
  return items;
}

interface CopyRow {
  canonical_uri: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  in_conflict: boolean;
  conflict_reviewed_at: string | null;
  federation_partners: { last_ok_at: string | null; created_at: string };
}

function importedItem(row: CopyRow, now: Date): YachtItem | null {
  if (row.in_conflict && row.conflict_reviewed_at === null) return null;
  const partner = {
    lastOkAt: row.federation_partners.last_ok_at ? new Date(row.federation_partners.last_ok_at) : null,
    createdAt: new Date(row.federation_partners.created_at),
  };
  const freshness = partnerFreshness(partner, now);
  if (freshness === "hidden") return null;
  const usage = isRecord(row.payload.usage) ? row.payload.usage : {};
  return {
    ...row.payload,
    x_key: importedKey(row.canonical_uri),
    x_source: "imported",
    x_provenance: { ...row.provenance, is_stale: freshness === "stale" },
    // ID-10: the authority's attribution travels with the listing wherever it is shown.
    x_attribution_text: usage.attribution_required === true && typeof usage.attribution_text === "string" ? usage.attribution_text : null,
  };
}

const COPY_COLUMNS = "canonical_uri, payload, provenance, in_conflict, conflict_reviewed_at, federation_partners(last_ok_at, created_at)";
const displayedCopies = () =>
  serviceClient().from("listing_copies").select(COPY_COLUMNS).eq("display_state", "published").is("tombstoned_at", null).not("payload", "is", null);

/**
 * Newest first, merged in memory. Correct and simple at the scale of one
 * brokerage; a node with tens of thousands of listings would page each source
 * separately or keep a combined index.
 */
export async function listYachts(source: Source): Promise<YachtItem[]> {
  const db = serviceClient();
  const [own, copies] = await Promise.all([
    source === "imported" ? { data: [], error: null } : db.from("listings").select(OWN_COLUMNS).in("status", ["active", "under_offer"]),
    source === "own" ? { data: [], error: null } : displayedCopies(),
  ]);
  if (own.error) throw new Error(`Cannot read listings: ${own.error.message}`);
  if (copies.error) throw new Error(`Cannot read partner listings: ${copies.error.message}`);
  const now = new Date();
  const items = [
    ...(await ownItems(own.data as StoredListing[])),
    ...(copies.data as unknown as CopyRow[]).map((row) => importedItem(row, now)).filter((item): item is YachtItem => item !== null),
  ];
  const updated = (item: YachtItem) => (typeof item.updated_at === "string" ? item.updated_at : "");
  return items.sort((a, b) => updated(b).localeCompare(updated(a)));
}

/** One yacht by its x_key: an own listing's UUID, or imported-{base64url canonical URI}. */
export async function findYacht(key: string): Promise<YachtItem | null> {
  const db = serviceClient();
  if (key.startsWith("imported-")) {
    const canonicalUri = Buffer.from(key.slice("imported-".length), "base64url").toString("utf8");
    const { data, error } = await displayedCopies().eq("canonical_uri", canonicalUri).maybeSingle();
    if (error) throw new Error(`Cannot read the partner listing: ${error.message}`);
    return data === null ? null : importedItem(data as unknown as CopyRow, new Date());
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) return null;
  const { data, error } = await db.from("listings").select(OWN_COLUMNS).eq("uuid", key).in("status", ["active", "under_offer"]).maybeSingle();
  if (error) throw new Error(`Cannot read the listing: ${error.message}`);
  return data === null ? null : ((await ownItems([data as StoredListing]))[0] ?? null);
}
