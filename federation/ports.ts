// The interfaces through which storage, HTTP and time reach the federation
// core. Nothing in ./federation imports a framework, a database client or an
// HTTP client: the host application implements these and passes them in.

export type TrustLevel = "verified" | "provisional" | "blocked";

/** A partner's published key, already validated and decoded (see well-known.ts). */
export interface PublishedKey {
  keyId: string;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  createdAt: string;
}

/** What the verifier needs to know about a partner. Spec: federation-protocol.md §Partner record. */
export interface PartnerRecord {
  domain: string;
  nodeUuid: string;
  trustLevel: TrustLevel;
  /** Keys cached from the partner's well-known document. */
  keys: PublishedKey[];
  /** Out-of-band pin (FP-12); `null` when the partner is not pinned. */
  pinnedKeyId: string | null;
}

export interface PartnerStore {
  findByDomain(domain: string): Promise<PartnerRecord | null>;
  /** Replaces the cached keys after a successful refetch. Must never move the pin (FP-12). */
  updateCachedKeys(domain: string, keys: PublishedKey[]): Promise<void>;
  /** FP-11: the domain now serves a different installation. */
  downgradeToProvisional(domain: string, change: { previousUuid: string; newUuid: string }): Promise<void>;
  /**
   * FP-13: stores a domain that has just made verified first contact, as
   * `provisional`. Optional: a store without it answers unknown senders
   * PARTNER_UNKNOWN. It is called only after the sender's signature has been
   * verified against keys fetched from its own domain.
   */
  registerFirstContact?(domain: string, discovered: DiscoveredNode): Promise<PartnerRecord>;
}

/** The identity and keys read from a partner's well-known document. */
export interface DiscoveredNode {
  nodeUuid: string;
  name: string;
  keys: PublishedKey[];
}

export interface WellKnownSource {
  /**
   * Fetches `https://{domain}/.well-known/openyacht` fresh, bypassing any
   * cache but respecting the per-domain refetch rate limit. Implementations
   * must refuse plain HTTP, invalid TLS (FP-2), redirects, and hosts that
   * resolve to private or loopback addresses, and must throw on any failure.
   */
  fetchFresh(domain: string): Promise<DiscoveredNode>;
}

export interface RequestTuple {
  node: string;
  timestamp: string;
  signature: string;
}

/**
 * Optional duplicate-request detection (a SHOULD in verification step 1).
 * Lookup and recording are separate so that only requests whose signature
 * verified are remembered: unauthenticated junk must not be able to grow the
 * store. Entries may be dropped once older than the timestamp window.
 */
export interface ReplayGuard {
  isReplay(tuple: RequestTuple): Promise<boolean>;
  remember(tuple: RequestTuple): Promise<void>;
}

export interface VerifierObserver {
  /** FP-11: administrators must be notified. */
  nodeUuidChanged?(event: { domain: string; previousUuid: string; newUuid: string }): void | Promise<void>;
  /** FP-13: an unknown domain made verified first contact and is now provisional. Administrators must be told. */
  firstContact?(event: { domain: string; nodeName: string }): void | Promise<void>;
  /** FP-10: rejections are logged. Never pass the full signature here (FP-4). */
  rejected?(event: { domain: string | null; code: string; reason: string }): void | Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ---------------------------------------------------------------------------
// Outbound HTTP
// ---------------------------------------------------------------------------

export interface OutboundRequest {
  method: "GET" | "POST" | "DELETE";
  url: URL;
  headers?: Record<string, string>;
  /** The exact bytes sent — the same bytes the signature was computed over. */
  body?: Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface OutboundResponse {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Implementations must verify TLS, refuse redirects and refuse non-public hosts. See https-client.ts. */
export interface OutboundHttp {
  request(request: OutboundRequest): Promise<OutboundResponse>;
}

// ---------------------------------------------------------------------------
// Consumer role: partners and copies
// ---------------------------------------------------------------------------

/**
 * What happens to a partner's listings once they have synchronised. Syncing is
 * not publishing: every listing the partner shares is stored as a copy; the
 * policy only decides whether a copy is displayed. It belongs to the partner,
 * never to the individual listing (api-design.md §Implementation Notes).
 */
export type AcceptancePolicy = "accept_all" | "accept_matching" | "hold";

/** A partner as the consumer role sees it: the verifier's record plus sync state. */
export interface Partner extends PartnerRecord {
  id: string;
  nodeName: string;
  keysFetchedAt: Date;
  acceptancePolicy: AcceptancePolicy;
  /** `updated_since` for the next poll; null means a cold sync. */
  syncWatermark: string | null;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  consecutiveFailures: number;
  /** The partner answered PARTNER_PROVISIONAL: reachable, waiting on a human there. */
  awaitingApproval: boolean;
  requestSentAt: Date | null;
  createdAt: Date;
}

export interface NewPartner {
  domain: string;
  nodeUuid: string;
  nodeName: string;
  trustLevel: TrustLevel;
  keys: PublishedKey[];
  pinnedKeyId: string | null;
  acceptancePolicy: AcceptancePolicy;
}

export interface PartnerRepository {
  findByDomain(domain: string): Promise<Partner | null>;
  create(partner: NewPartner): Promise<Partner>;
  /** Replaces cached keys and the node name after a well-known fetch. Never moves the pin. */
  updateDiscovery(partnerId: string, discovery: { nodeName: string; keys: PublishedKey[] }): Promise<void>;
  setPinnedKey(partnerId: string, keyId: string | null): Promise<void>;
  setTrustLevel(partnerId: string, trustLevel: TrustLevel): Promise<void>;
  /** FP-11: records the new UUID and downgrades in one step. */
  recordUuidChange(partnerId: string, newUuid: string): Promise<void>;
  markRequestSent(partnerId: string, at: Date): Promise<void>;
  recordSyncSuccess(partnerId: string, result: { at: Date; watermark: string | null }): Promise<void>;
  recordAwaitingApproval(partnerId: string, at: Date): Promise<void>;
  recordSyncFailure(partnerId: string, at: Date): Promise<void>;
  countCopies(partnerId: string): Promise<number>;
  delete(partnerId: string): Promise<void>;
}

/** The mandatory provenance block (ID-3). Spec: yacht-identity.md §What everyone else holds. */
export interface Provenance {
  canonical: string;
  authority: string;
  received_at: string;
  signature_verified: boolean;
}

export type CopyDisplayState = "published" | "held";

/** A received listing. Stored apart from this node's own listings, always (ID-4, ID-5). */
export interface ListingCopy {
  /** The canonical URI — an opaque string, compared byte for byte (ID-2). */
  canonicalUri: string;
  partnerId: string;
  type: "sale" | "charter";
  status: string;
  updatedAt: string;
  /** The payload as received, with `descriptions[].content` sanitised (LS-5). Null once tombstoned. */
  payload: Record<string, unknown> | null;
  provenance: Provenance;
  tombstonedAt: string | null;
  displayState: CopyDisplayState;
  /** Why a copy is held; empty when published. */
  heldReasons: string[];
  /** HIN / IMO, normalised, for hard-identifier conflict detection (ID-9). */
  hardIdentifiers: string[];
  /**
   * Another authority's active listing claims the same vessel (ID-9). Kept
   * apart from `displayState` and applied on top of it when displaying, so
   * that clearing a conflict never has to re-run another partner's policy.
   */
  inConflict: boolean;
  /** Builder or category slugs not present in the vendored registries (LS-12). */
  unknownSlugs: string[];
}

export interface CopyRepository {
  find(canonicalUri: string): Promise<ListingCopy | null>;
  upsert(copy: ListingCopy): Promise<void>;
  /** Live (not tombstoned) copies, from any partner, carrying any of these hard identifiers (ID-9). */
  findLiveByHardIdentifiers(identifiers: string[]): Promise<ListingCopy[]>;
  setConflict(canonicalUris: string[], inConflict: boolean): Promise<void>;
}

/** Restricted-HTML sanitiser for `descriptions[].content` (LS-5). The host supplies the implementation. */
export interface HtmlSanitiser {
  sanitise(html: string): string;
}

/** The vendored builder and category registries (LS-12). Read from disk by the host, never fetched. */
export interface SlugRegistry {
  hasBuilder(slug: string): boolean;
  hasCategory(slug: string): boolean;
}
