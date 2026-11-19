// The query string of the two listing index pages, own listings and partner
// listings: which tab, which filters, which page. Pure, so it is tested
// without a request or a database.
//
// Tabs split listings by where they are in the lifecycle (ID-8): live ones
// (active, under offer) are what partners and websites see, past ones (sold,
// withdrawn) are kept for the record. Own listings add a tab for drafts,
// which have never been distributed.

export const PAGE_SIZE = 50;

export const LISTING_TYPES = ["sale", "charter"] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

export interface IndexView {
  key: string;
  label: string;
  statuses: readonly string[];
}

export const OWN_LISTING_VIEWS = [
  { key: "live", label: "Live", statuses: ["active", "under_offer"] },
  { key: "drafts", label: "Drafts", statuses: ["draft"] },
  { key: "past", label: "Past", statuses: ["sold", "withdrawn"] },
] as const satisfies IndexViews;

// A partner's listing is past once its authority has ended it: the copy then
// holds a tombstone and no data (ID-7), so the past tab lists what ended, when,
// and from whom — nothing that could be shown as a listing.
export const PARTNER_LISTING_VIEWS = [
  { key: "live", label: "Live", statuses: ["active", "under_offer"] },
  { key: "past", label: "Past", statuses: ["sold", "withdrawn"] },
] as const satisfies IndexViews;

/** At least one view: the first is the default tab. */
export type IndexViews = readonly [IndexView, ...IndexView[]];

export interface IndexQuery {
  view: string;
  type: ListingType | null;
  status: string | null;
  /** A partner id, kept as the string it arrived as: ids are bigints. */
  partner: string | null;
  q: string;
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined) => (typeof value === "string" ? value.trim() : "");

/** Unknown or malformed values fall back to "no filter" rather than an error: these are bookmarkable URLs. */
export function parseIndexQuery(params: SearchParams, views: IndexViews): IndexQuery {
  const view = views.find((candidate) => candidate.key === single(params.view)) ?? views[0];
  const type = single(params.type);
  const status = single(params.status);
  const partner = single(params.partner);
  const page = Number(single(params.page));
  return {
    view: view.key,
    type: (LISTING_TYPES as readonly string[]).includes(type) ? (type as ListingType) : null,
    // A status from another tab would filter to nothing, so it is dropped.
    status: view.statuses.includes(status) ? status : null,
    partner: /^[1-9]\d{0,17}$/.test(partner) ? partner : null,
    q: single(params.q).slice(0, 100),
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

export function statusesOf(views: IndexViews, key: string): readonly string[] {
  return (views.find((view) => view.key === key) ?? views[0]).statuses;
}

/**
 * The URL of the same index with some of the query changed. Any change other
 * than the page itself starts again at page one; empty values are left out.
 */
export function indexHref(path: string, query: IndexQuery, change: Partial<IndexQuery>): string {
  const next = { ...query, page: 1, ...change };
  const params = new URLSearchParams();
  params.set("view", next.view);
  if (next.type) params.set("type", next.type);
  if (next.status) params.set("status", next.status);
  if (next.partner) params.set("partner", next.partner);
  if (next.q) params.set("q", next.q);
  if (next.page > 1) params.set("page", String(next.page));
  return `${path}?${params.toString()}`;
}

/**
 * A case-insensitive substring pattern for one condition of a PostgREST
 * `or=(…)` filter. LIKE's own wildcards in the search are escaped so they match
 * literally, `*` (PostgREST's wildcard) is dropped, and the value is
 * double-quoted so commas and parentheses cannot end the condition early.
 */
export function containsPattern(search: string): string {
  const like = search.replace(/\*/g, "").replace(/[\\%_]/g, (character) => `\\${character}`);
  return `"*${like.replace(/["\\]/g, (character) => `\\${character}`)}*"`;
}

/** The first and last row of a page, for the client's `.range()`. */
export function pageRange(page: number): [number, number] {
  const from = (page - 1) * PAGE_SIZE;
  return [from, from + PAGE_SIZE - 1];
}
