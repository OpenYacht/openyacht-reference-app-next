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
  /** FP-10: rejections are logged. Never pass the full signature here (FP-4). */
  rejected?(event: { domain: string | null; code: string; reason: string }): void | Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
