// The consumer's sync engine: cold sync and `updated_since` polling (API-2,
// API-3, ID-7). Spec: api-design.md §Listings, federation-protocol.md §Health
// and Failure Handling.
import { decideDisplay, hardIdentifiers, sanitisePayload, unknownSlugs } from "./copies";
import { toWireTimestamp } from "./errors";
import { FeedError, isTerminalStatus, parseFeedPage, type FeedItem } from "./feed";
import {
  systemClock,
  type Clock,
  type CopyRepository,
  type HtmlSanitiser,
  type ListingCopy,
  type Partner,
  type PartnerRepository,
  type SlugRegistry,
} from "./ports";
import type { SignedClient } from "./signed-client";
import { API_BASE_PATH } from "./well-known";

const DEFAULT_PAGE_SIZE = 50;
const PREFERRED_PAGE_SIZE = 100;
/** A cursor that never ends is a partner bug or an attack; either way it must not run forever. */
const MAX_PAGES = 2000;

export type SyncOutcome =
  | { status: "synced"; pages: number; created: number; updated: number; tombstoned: number; unchanged: number; rejected: number }
  /** The partner is reachable and has not approved us yet. Not a failure. */
  | { status: "awaiting_approval" }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface SyncEngineOptions {
  client: SignedClient;
  partners: PartnerRepository;
  copies: CopyRepository;
  sanitiser: HtmlSanitiser;
  registry: SlugRegistry;
  clock?: Clock;
}

export class SyncEngine {
  private readonly clock: Clock;

  constructor(private readonly options: SyncEngineOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async syncPartner(partner: Partner): Promise<SyncOutcome> {
    if (partner.trustLevel === "blocked") return { status: "skipped", reason: "The partner is blocked." };
    // Listings are only consumed from partners an administrator here has
    // approved (FP-13): a provisional partner is known, not trusted.
    if (partner.trustLevel !== "verified") return { status: "skipped", reason: "The partner has not been approved on this node." };

    const startedAt = this.clock.now();
    try {
      return await this.run(partner, startedAt);
    } catch (error) {
      // Transport failures, a refused host, an unparseable page: the partner
      // could not be synced, and the backoff counter says so.
      await this.options.partners.recordSyncFailure(partner.id, startedAt);
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(partner: Partner, startedAt: Date): Promise<SyncOutcome> {
    const pageSize = await this.pageSizeFor(partner.domain);
    const counts = { pages: 0, created: 0, updated: 0, tombstoned: 0, unchanged: 0, rejected: 0 };
    let watermark = partner.syncWatermark;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    do {
      const query = new URLSearchParams();
      // No `updated_since` at all on a cold sync: everything the partner shares.
      if (partner.syncWatermark !== null) query.set("updated_since", partner.syncWatermark);
      if (cursor !== null) query.set("cursor", cursor);
      query.set("page_size", String(pageSize));

      const response = await this.options.client.get(partner.domain, `${API_BASE_PATH}/listings?${query}`);

      if (response.status === 403 && response.errorCode === "PARTNER_PROVISIONAL") {
        // "Authenticated but not yet approved": the request was delivered, the
        // signature verified, and the authority answered correctly. Nothing
        // failed. Counting it as a failure would put a partner that is doing
        // exactly what the handshake asks on a growing backoff, so that when
        // a human finally approves, this node sits idle for hours.
        await this.options.partners.recordAwaitingApproval(partner.id, startedAt);
        return { status: "awaiting_approval" };
      }
      if (response.status === 429) {
        // Retry-After governs here, not the failure backoff.
        return { status: "rate_limited", retryAfterSeconds: response.retryAfterSeconds };
      }
      if (response.status !== 200) {
        await this.options.partners.recordSyncFailure(partner.id, startedAt);
        const detail = response.errorCode === null ? "" : ` ${response.errorCode}: ${response.errorMessage ?? ""}`;
        return { status: "failed", reason: `${partner.domain} answered ${response.status}.${detail}`.trim() };
      }

      const page = parseFeedPage(response.json, partner.domain);
      counts.pages++;
      counts.rejected += page.rejected.length;
      for (const item of page.items) {
        counts[await this.apply(partner, item)]++;
        if (watermark === null || item.updatedAt > watermark) watermark = item.updatedAt;
      }

      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor) || counts.pages >= MAX_PAGES) throw new FeedError("The partner's pagination does not terminate.");
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    // The watermark is the newest `updated_at` seen, in the authority's own
    // clock — never this node's. `updated_since` is inclusive, so the next poll
    // re-reads the boundary item; applying it again is a no-op.
    await this.options.partners.recordSyncSuccess(partner.id, { at: startedAt, watermark });
    return { status: "synced", ...counts };
  }

  /** API-7: read the partner's advertised limit; degrade to a safe default if it cannot be read. */
  private async pageSizeFor(domain: string): Promise<number> {
    try {
      const response = await this.options.client.getUnsigned(domain, `${API_BASE_PATH}/capabilities`);
      const limits = isRecord(response.json) && isRecord(response.json.limits) ? response.json.limits : {};
      const max = limits.page_size_max;
      if (response.status === 200 && typeof max === "number" && Number.isInteger(max) && max > 0) return Math.min(PREFERRED_PAGE_SIZE, max);
    } catch {
      // Falls through to the default.
    }
    return DEFAULT_PAGE_SIZE;
  }

  private async apply(partner: Partner, item: FeedItem): Promise<"created" | "updated" | "tombstoned" | "unchanged"> {
    const existing = await this.options.copies.find(item.canonicalUri);
    // A copy belongs to the partner it first came from. parseFeedPage already
    // guarantees the URI is under this partner's domain; this guards the store.
    if (existing !== null && existing.partnerId !== partner.id) return "unchanged";

    const provenance = {
      canonical: item.canonicalUri,
      authority: partner.domain,
      received_at: toWireTimestamp(this.clock.now()),
      // True by construction: the page came back over verified TLS from the
      // authority's own identity domain, in answer to a request we signed.
      signature_verified: true,
    };

    // A withdrawal, a sale or an unsharing — and equally a full payload that
    // arrives with a terminal status. All use of the data ends (ID-7, ID-10),
    // so the payload is dropped rather than kept out of sight.
    if (item.kind === "tombstone" || isTerminalStatus(item.status)) {
      if (existing === null) return "unchanged";
      if (existing.tombstonedAt !== null && existing.updatedAt === item.updatedAt) return "unchanged";
      await this.options.copies.upsert({
        ...existing,
        status: item.status,
        updatedAt: item.updatedAt,
        payload: null,
        provenance,
        tombstonedAt: item.updatedAt,
        displayState: "held",
        heldReasons: ["The listing has ended."],
        inConflict: false,
      });
      await this.recomputeConflicts(existing.hardIdentifiers);
      return "tombstoned";
    }

    // Deliberately no "is this older than what I hold?" check. A tombstone is
    // stamped at the moment of unsharing; when the listing is shared again it
    // returns with its own, earlier `updated_at`. Dropping it as stale would
    // keep a withdrawn copy of a live listing.
    if (existing !== null && existing.tombstonedAt === null && existing.updatedAt === item.updatedAt && existing.status === item.status) {
      return "unchanged";
    }

    const payload = sanitisePayload(item.payload, this.options.sanitiser);
    const identifiers = hardIdentifiers(payload);
    const copy: ListingCopy = {
      canonicalUri: item.canonicalUri,
      partnerId: partner.id,
      type: item.type,
      status: item.status,
      updatedAt: item.updatedAt,
      payload,
      provenance,
      tombstonedAt: null,
      ...decideDisplay(payload, partner.acceptancePolicy),
      hardIdentifiers: identifiers,
      inConflict: false,
      unknownSlugs: unknownSlugs(payload, this.options.registry),
    };
    await this.options.copies.upsert(copy);
    await this.recomputeConflicts([...new Set([...identifiers, ...(existing?.hardIdentifiers ?? [])])]);
    return existing === null ? "created" : "updated";
  }

  /**
   * ID-9: when live listings from different authorities name the same vessel
   * by HIN or IMO, both are kept and both are flagged for a person. Nothing is
   * resolved automatically — it is usually a mandate handover in progress or a
   * genuine dispute, and software would be wrong half the time.
   */
  private async recomputeConflicts(identifiers: string[]): Promise<void> {
    if (identifiers.length === 0) return;
    // A copy may carry both a HIN and an IMO, so its flag is decided across
    // all of its identifiers at once — deciding per identifier would let one
    // clear what the other had just set. Widen the set once to pull in the
    // copies reachable through a second identifier.
    const touched = await this.options.copies.findLiveByHardIdentifiers(identifiers);
    const widened = [...new Set([...identifiers, ...touched.flatMap((copy) => copy.hardIdentifiers)])];
    const live = widened.length === identifiers.length ? touched : await this.options.copies.findLiveByHardIdentifiers(widened);

    const conflicted = (copy: ListingCopy) =>
      live.some(
        (other) => other.partnerId !== copy.partnerId && other.hardIdentifiers.some((identifier) => copy.hardIdentifiers.includes(identifier)),
      );
    const toFlag = live.filter((copy) => !copy.inConflict && conflicted(copy)).map((copy) => copy.canonicalUri);
    const toClear = live.filter((copy) => copy.inConflict && !conflicted(copy)).map((copy) => copy.canonicalUri);
    if (toFlag.length > 0) await this.options.copies.setConflict(toFlag, true);
    if (toClear.length > 0) await this.options.copies.setConflict(toClear, false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
