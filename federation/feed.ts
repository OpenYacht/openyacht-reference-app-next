// Reading a partner's /listings response. Spec: api-design.md §Listings.
//
// Everything in it is untrusted input (FP-14). Only what the sync engine
// relies on is validated here, and unknown fields are ignored rather than
// rejected (API-8) — which is why this is not a strict schema validation: the
// published schemas forbid unknown fields, the wire contract requires
// tolerating them.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_URI = new RegExp(`^https://([^/]+)/openyacht/v1/listings/${UUID}$`);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STATUSES = new Set(["active", "under_offer", "sold", "withdrawn"]);
const TERMINAL_STATUSES = new Set(["sold", "withdrawn"]);

export class FeedError extends Error {}

export type FeedItem =
  | { kind: "listing"; canonicalUri: string; type: "sale" | "charter"; status: string; updatedAt: string; payload: Record<string, unknown> }
  | { kind: "tombstone"; canonicalUri: string; status: string; updatedAt: string };

export interface FeedPage {
  items: FeedItem[];
  /** Items that were skipped, and why. A bad item never fails the page. */
  rejected: { id: string | null; reason: string }[];
  /** Absent on the last page — the one deliberate absence in the protocol. */
  nextCursor: string | null;
}

export const isTerminalStatus = (status: string) => TERMINAL_STATUSES.has(status);

export function parseFeedPage(body: unknown, authorityDomain: string): FeedPage {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.meta)) throw new FeedError("Not a listings collection.");
  const page: FeedPage = { items: [], rejected: [], nextCursor: null };
  const cursor = body.meta.next_cursor;
  if (typeof cursor === "string" && cursor !== "") page.nextCursor = cursor;

  for (const entry of body.data) {
    const result = parseFeedItem(entry, authorityDomain);
    if ("reason" in result) page.rejected.push(result);
    else page.items.push(result);
  }
  return page;
}

export function parseFeedItem(entry: unknown, authorityDomain: string): FeedItem | { id: string | null; reason: string } {
  if (!isRecord(entry)) return { id: null, reason: "not an object" };
  const id = typeof entry.id === "string" ? entry.id : null;
  const reject = (reason: string) => ({ id, reason });

  const match = id === null ? null : CANONICAL_URI.exec(id);
  if (id === null || match === null) return reject("id is not a canonical listing URI");
  // ID-1: a node mints canonical URIs under its own domain only. A listing
  // that names another authority is a relay (ID-6) or a forgery; taking it
  // would let one partner overwrite another partner's copies.
  if (match[1] !== authorityDomain) return reject(`canonical URI is not under ${authorityDomain}`);

  if (typeof entry.status !== "string" || !STATUSES.has(entry.status)) return reject("unknown status");
  if (typeof entry.updated_at !== "string" || !TIMESTAMP.test(entry.updated_at)) return reject("updated_at is not an RFC 3339 UTC timestamp");

  if (entry.tombstone === true) return { kind: "tombstone", canonicalUri: id, status: entry.status, updatedAt: entry.updated_at };

  if (entry.type !== "sale" && entry.type !== "charter") return reject("unknown listing type");
  return { kind: "listing", canonicalUri: id, type: entry.type, status: entry.status, updatedAt: entry.updated_at, payload: entry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
