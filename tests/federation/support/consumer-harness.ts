// In-memory stand-ins for the consumer-role ports, and a fake authority node
// that verifies every signed request with the real Verifier — so these tests
// exercise signing and verification end to end rather than against a mock
// that accepts anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodePublicKey,
  generateKeypair,
  Signer,
  SignedClient,
  Verifier,
  type CopyRepository,
  type DiscoveredNode,
  type ListingCopy,
  type NewPartner,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
  type Partner,
  type PartnerRepository,
  type PublishedKey,
  type WellKnownSource,
} from "@/federation";

export const OWN_DOMAIN = "consumer.example";
export const AUTHORITY = "authority.example";
export const NOW = new Date("2026-09-18T12:00:00Z");
export const clock = { now: () => NOW };

const ownKeys = generateKeypair();
export const ownPublishedKey: PublishedKey = {
  keyId: ownKeys.keyId,
  publicKey: decodePublicKey(ownKeys.publicKey),
  createdAt: "2026-09-01T00:00:00Z",
};
export const signer = new Signer(OWN_DOMAIN, ownKeys, clock);

export function publishedKey(): PublishedKey {
  const pair = generateKeypair();
  return { keyId: pair.keyId, publicKey: decodePublicKey(pair.publicKey), createdAt: "2026-09-01T00:00:00Z" };
}

const saleExample = JSON.parse(readFileSync(join(process.cwd(), "protocol/examples/valid/sale-full.json"), "utf8")) as Record<string, unknown>;

export const uri = (n: number, domain = AUTHORITY) =>
  `https://${domain}/openyacht/v1/listings/018f6d2e-9f0a-7cc3-a1b2-${String(n).padStart(12, "0")}`;

/** A schema-valid sale listing from the protocol's own example, re-addressed and overridden. */
export function listing(n: number, updatedAt: string, overrides: Record<string, unknown> = {}, domain = AUTHORITY): Record<string, unknown> {
  // A distinct HIN per listing unless a test sets one: the example's own HIN on
  // every listing would make them all the same vessel.
  const vessel = { ...(saleExample.vessel as object), hin: `HIN${String(n).padStart(9, "0")}`, imo: null };
  return { ...structuredClone(saleExample), vessel, id: uri(n, domain), updated_at: updatedAt, ...overrides };
}

export const tombstone = (n: number, updatedAt: string, status = "withdrawn") => ({ id: uri(n), tombstone: true, status, updated_at: updatedAt });

export class MemoryPartners implements PartnerRepository {
  readonly rows = new Map<string, Partner>();
  copyCounts = new Map<string, number>();

  async findByDomain(domain: string) {
    return [...this.rows.values()].find((partner) => partner.domain === domain) ?? null;
  }
  async create(input: NewPartner) {
    const partner: Partner = {
      ...input,
      id: `partner-${this.rows.size + 1}`,
      keysFetchedAt: NOW,
      syncWatermark: null,
      lastOkAt: null,
      lastAttemptAt: null,
      consecutiveFailures: 0,
      awaitingApproval: false,
      requestSentAt: null,
      createdAt: NOW,
    };
    this.rows.set(partner.id, partner);
    return partner;
  }
  private patch(id: string, changes: Partial<Partner>) {
    this.rows.set(id, { ...this.rows.get(id)!, ...changes });
  }
  async updateDiscovery(id: string, discovery: { nodeName: string; keys: PublishedKey[] }) {
    this.patch(id, { ...discovery, keysFetchedAt: NOW });
  }
  async setPinnedKey(id: string, pinnedKeyId: string | null) {
    this.patch(id, { pinnedKeyId });
  }
  async setTrustLevel(id: string, trustLevel: Partner["trustLevel"]) {
    this.patch(id, { trustLevel });
  }
  async recordUuidChange(id: string, nodeUuid: string) {
    this.patch(id, { nodeUuid, trustLevel: "provisional" });
  }
  async markRequestSent(id: string, requestSentAt: Date) {
    this.patch(id, { requestSentAt });
  }
  async recordSyncSuccess(id: string, result: { at: Date; watermark: string | null }) {
    this.patch(id, {
      lastOkAt: result.at,
      lastAttemptAt: result.at,
      syncWatermark: result.watermark,
      consecutiveFailures: 0,
      awaitingApproval: false,
    });
  }
  async recordAwaitingApproval(id: string, at: Date) {
    this.patch(id, { lastAttemptAt: at, awaitingApproval: true });
  }
  async recordSyncFailure(id: string, at: Date) {
    this.patch(id, { lastAttemptAt: at, consecutiveFailures: this.rows.get(id)!.consecutiveFailures + 1 });
  }
  async countCopies(id: string) {
    return this.copyCounts.get(id) ?? 0;
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  get(id: string) {
    return this.rows.get(id)!;
  }
}

export class MemoryCopies implements CopyRepository {
  readonly rows = new Map<string, ListingCopy>();
  async find(canonicalUri: string) {
    return this.rows.get(canonicalUri) ?? null;
  }
  async upsert(copy: ListingCopy) {
    this.rows.set(copy.canonicalUri, copy);
  }
  async findLiveByHardIdentifiers(identifiers: string[]) {
    return [...this.rows.values()].filter((copy) => copy.tombstonedAt === null && copy.hardIdentifiers.some((id) => identifiers.includes(id)));
  }
  async setConflict(canonicalUris: string[], inConflict: boolean) {
    for (const canonicalUri of canonicalUris) this.rows.set(canonicalUri, { ...this.rows.get(canonicalUri)!, inConflict });
  }
}

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  verified: boolean;
}

type Route = (request: RecordedRequest) => { status: number; json?: unknown; headers?: Record<string, string> } | Error;

/**
 * A fake partner node. Signed paths are verified with the real Verifier
 * against this consumer's key; a bad signature answers 401 like a real node.
 */
export class FakeAuthority implements OutboundHttp {
  readonly requests: RecordedRequest[] = [];
  capabilities: unknown = { protocol_versions: ["1.0"], features: {}, limits: { page_size_max: 100, rate_per_hour: 500 } };

  constructor(
    private readonly domain: string,
    private readonly route: Route,
  ) {}

  async request(outbound: OutboundRequest): Promise<OutboundResponse> {
    const { url } = outbound;
    const unsigned = url.pathname.endsWith("/capabilities") || url.pathname.endsWith("/health");
    const body = outbound.body ?? new Uint8Array(0);
    let verified = false;
    if (!unsigned) {
      const verifier = new Verifier({
        ownDomain: this.domain,
        clock,
        partners: {
          findByDomain: async () => ({
            domain: OWN_DOMAIN,
            nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd",
            trustLevel: "verified",
            keys: [ownPublishedKey],
            pinnedKeyId: null,
          }),
          updateCachedKeys: async () => {},
          downgradeToProvisional: async () => {},
        },
        wellKnown: { fetchFresh: async () => ({ nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd", name: "Consumer", keys: [ownPublishedKey] }) },
      });
      verified = (
        await verifier.verify({ method: outbound.method, pathAndQuery: url.pathname + url.search, headers: new Headers(outbound.headers), body })
      ).ok;
    }
    const recorded: RecordedRequest = {
      method: outbound.method,
      host: url.hostname,
      path: url.pathname,
      query: url.searchParams,
      body: body.length > 0 ? JSON.parse(Buffer.from(body).toString("utf8")) : null,
      verified,
    };
    this.requests.push(recorded);

    if (unsigned) return respond(200, this.capabilities);
    if (!verified)
      return respond(401, {
        error: { code: "SIGNATURE_INVALID", message: "bad signature" },
        meta: { request_id: "r", time: "2026-09-18T12:00:00Z" },
      });
    const result = this.route(recorded);
    if (result instanceof Error) throw result;
    return respond(result.status, result.json, result.headers);
  }

  get signed() {
    return this.requests.filter((request) => !request.path.endsWith("/capabilities"));
  }
}

function respond(status: number, json?: unknown, headers: Record<string, string> = {}): OutboundResponse {
  return { status, headers, body: json === undefined ? new Uint8Array(0) : Buffer.from(JSON.stringify(json), "utf8") };
}

export const errorEnvelope = (code: string) => ({ error: { code, message: code }, meta: { request_id: "r", time: "2026-09-18T12:00:00Z" } });
export const page = (data: unknown[], nextCursor?: string) => ({
  data,
  meta: { ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), generated_at: "2026-09-18T12:00:00Z", protocol_version: "1.0" },
});

export const clientFor = (authority: OutboundHttp) => new SignedClient(async () => signer, authority);

export function discovery(node: Partial<DiscoveredNode> & { keys: PublishedKey[] }): WellKnownSource & { calls: number } {
  return {
    calls: 0,
    async fetchFresh() {
      this.calls++;
      return { nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd", name: "Authority Yachts", ...node };
    },
  };
}
