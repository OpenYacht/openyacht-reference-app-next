// The authority's /listings endpoint, minus storage: query parsing, the opaque
// cursor, and the collection envelope. Spec: api-design.md §Listings.
import { toWireTimestamp } from "./errors";
import type { OpenYachtListing, OpenYachtListingsCollection, OpenYachtTombstone } from "./generated";
import { PROTOCOL_VERSION } from "./well-known";

export class FeedQueryError extends Error {}

/** Where a page ended: the last row's effective time — at the database's full precision — and its id. */
export interface FeedPosition {
  at: string;
  id: string;
}

export interface FeedQuery {
  /** `updated_since`, verbatim; null for a cold sync. */
  since: string | null;
  after: FeedPosition | null;
  pageSize: number;
}

export type ServedItem = OpenYachtListing | OpenYachtTombstone;

/** What the endpoint needs from storage. The host implements it; tests fake it. */
export interface ListingFeedSource {
  /** One page for one partner, already filtered and gated for it (API-5). `next` is null on the last page. */
  page(partnerDomain: string, query: FeedQuery): Promise<{ items: ServedItem[]; next: FeedPosition | null }>;
  /**
   * One listing by UUID. `null` covers every reason a partner may not have it —
   * unshared, draft, unknown — so that probing UUIDs teaches nothing. `"gone"`
   * is a listing the partner could see that ended longer ago than the retention period.
   */
  one(partnerDomain: string, uuid: string): Promise<OpenYachtListing | "gone" | null>;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const POSITION_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The cursor is opaque to consumers (API-2): they store it and send it back,
 * nothing more. It is a keyset position, not an offset, so a crawl neither
 * skips nor repeats rows while listings are being written.
 */
export function encodeCursor(position: FeedPosition): string {
  return Buffer.from(JSON.stringify([position.at, position.id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): FeedPosition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new FeedQueryError("cursor is not one this node issued.");
  }
  // It comes back from outside, so it is validated like any other input
  // before it goes anywhere near a query.
  if (!Array.isArray(decoded) || decoded.length !== 2) throw new FeedQueryError("cursor is not one this node issued.");
  const [at, id] = decoded as unknown[];
  if (typeof at !== "string" || !POSITION_AT.test(at) || typeof id !== "string" || !/^\d{1,18}$/.test(id)) {
    throw new FeedQueryError("cursor is not one this node issued.");
  }
  return { at, id };
}

export function parseFeedQuery(params: URLSearchParams, limits: { pageSizeDefault: number; pageSizeMax: number }): FeedQuery {
  const since = params.get("updated_since");
  if (since !== null && !TIMESTAMP.test(since))
    throw new FeedQueryError("updated_since must be an RFC 3339 UTC timestamp, such as 2026-08-01T00:00:00Z.");

  let pageSize = limits.pageSizeDefault;
  const requested = params.get("page_size");
  if (requested !== null) {
    if (!/^\d{1,6}$/.test(requested) || Number(requested) < 1) throw new FeedQueryError("page_size must be a positive integer.");
    // Asking for more than the advertised maximum gets the maximum.
    pageSize = Math.min(Number(requested), limits.pageSizeMax);
  }

  const cursor = params.get("cursor");
  return { since, after: cursor === null ? null : decodeCursor(cursor), pageSize };
}

export function buildCollection(items: ServedItem[], next: FeedPosition | null, now: Date): OpenYachtListingsCollection {
  return {
    data: items,
    meta: {
      // Absent — not null — on the last page: the one deliberate absence in the protocol.
      ...(next === null ? {} : { next_cursor: encodeCursor(next) }),
      generated_at: toWireTimestamp(now),
      protocol_version: PROTOCOL_VERSION,
    },
  };
}
