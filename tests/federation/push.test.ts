// Push subscriptions (API-10, API-11): registration and the inbox through the
// real handlers, the consumer's held-state dedup through the real sync
// engine, and subscribing through the real partner service.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodePublicKey,
  generateKeypair,
  isSyncDue,
  parseFeedItem,
  PartnerService,
  Signer,
  SyncEngine,
  Verifier,
  type DiscoveredNode,
  type FeedItem,
  type PartnerRecord,
  type TrustLevel,
} from "@/federation";
import { createFederationHandlers, type InboundFederation } from "@/lib/federation/handlers";
import {
  AUTHORITY,
  clientFor,
  clock,
  discovery,
  FakeAuthority,
  listing,
  MemoryCopies,
  MemoryPartners,
  NOW,
  OWN_DOMAIN,
  publishedKey,
  tombstone,
  uri,
} from "./support/consumer-harness";

const DOMAIN = "node.brokerage.example";
const SENDER = "partner.example";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  const dir = join(process.cwd(), "protocol/schemas/v1");
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")));
});
const schema = (name: string) => ajv.getSchema(`https://openyacht.org/schemas/v1/${name}.schema.json`)!;

const senderKeys = generateKeypair();
const discovered: DiscoveredNode = {
  nodeUuid: NODE_UUID,
  name: "Partner Yachts",
  keys: [{ keyId: senderKeys.keyId, publicKey: decodePublicKey(senderKeys.publicKey), createdAt: "2026-09-01T00:00:00Z" }],
};

function node(options: { pushEnabled?: boolean; trust?: TrustLevel; subscribed?: boolean } = {}) {
  const partners = new Map<string, PartnerRecord>([
    [SENDER, { domain: SENDER, nodeUuid: NODE_UUID, trustLevel: options.trust ?? "verified", keys: discovered.keys, pinnedKeyId: null }],
  ]);
  const callbacks = new Map<string, string | null>();
  const applied: FeedItem[] = [];
  const inbound: InboundFederation = {
    verify: (request) =>
      new Verifier({
        ownDomain: DOMAIN,
        clock,
        partners: {
          findByDomain: async (domain) => partners.get(domain) ?? null,
          updateCachedKeys: async () => {},
          downgradeToProvisional: async () => {},
        },
        wellKnown: { fetchFresh: async () => discovered },
      }).verify(request),
    recordPartnerRequest: async () => {},
    log: async () => {},
    setPushCallback: async (domain, callback) => void callbacks.set(domain, callback),
    applyDelivery: async (_domain, item) => {
      if (!options.subscribed) return "not_subscribed";
      applied.push(item);
      return "created";
    },
  };
  const handlers = createFederationHandlers({
    identity: () => ({ domain: DOMAIN, name: "Example Yacht Brokerage", website: null }),
    store: {
      getState: async () => ({ nodeUuid: NODE_UUID, identityDomain: DOMAIN, setupCompleted: true, pushEnabled: options.pushEnabled ?? true }),
      listPublishedKeys: async () => [{ keyId: senderKeys.keyId, publicKey: senderKeys.publicKey, createdAt: "2026-09-01T00:00:00Z" }],
    },
    clock,
    software: "test",
    requestId: () => "req_test",
    inbound,
  });
  return { handlers, callbacks, applied };
}

function signed(method: "POST" | "DELETE", path: string, body?: unknown) {
  const url = new URL(`https://${DOMAIN}${path}`);
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
  const headers = new Signer(SENDER, senderKeys, clock).sign({ method, url, body: bytes });
  return new Request(url, { method, headers: { ...headers, host: DOMAIN, "content-type": "application/json" }, body: bytes });
}
const unsigned = (path: string) => new Request(`https://${DOMAIN}${path}`, { headers: { host: DOMAIN } });

describe("API-10 advertising push subscriptions", () => {
  it("offers them in capabilities and the well-known document only while switched on", async () => {
    for (const pushEnabled of [true, false]) {
      const { handlers } = node({ pushEnabled });
      const capabilities = await (await handlers.capabilities(unsigned("/openyacht/v1/capabilities"))).json();
      expect(capabilities.features.subscriptions).toBe(pushEnabled);
      expect(schema("capabilities")(capabilities)).toBe(true);
      const wellKnown = await (await handlers.wellKnown(unsigned("/.well-known/openyacht"))).json();
      expect(wellKnown.endpoints.subscriptions).toBe(pushEnabled ? "/openyacht/v1/subscriptions" : undefined);
    }
  });

  it("answers the registration route NOT_FOUND while switched off, before any authentication", async () => {
    const { handlers, callbacks } = node({ pushEnabled: false });
    const response = await handlers.subscriptions(
      new Request(`https://${DOMAIN}/openyacht/v1/subscriptions`, { method: "POST", headers: { host: DOMAIN } }),
    );
    expect(response.status).toBe(404);
    expect(callbacks.size).toBe(0);
  });
});

describe("API-10 registering a callback", () => {
  it("stores a public https callback for a verified partner, and removes it idempotently", async () => {
    const { handlers, callbacks } = node();
    const registered = await handlers.subscriptions(
      signed("POST", "/openyacht/v1/subscriptions", { callback: "https://partner.example/openyacht/v1/inbox" }),
    );
    expect(registered.status).toBe(204);
    expect(callbacks.get(SENDER)).toBe("https://partner.example/openyacht/v1/inbox");
    expect((await handlers.subscriptions(signed("DELETE", "/openyacht/v1/subscriptions"))).status).toBe(204);
    expect((await handlers.subscriptions(signed("DELETE", "/openyacht/v1/subscriptions"))).status).toBe(204);
    expect(callbacks.get(SENDER)).toBeNull();
  });

  it.each(["http://partner.example/inbox", "https://10.0.0.5/inbox", "https://partner.example:8443/inbox", "https://user:pw@partner.example/inbox"])(
    "refuses %s with VALIDATION_ERROR",
    async (callback) => {
      const { handlers, callbacks } = node();
      const response = await handlers.subscriptions(signed("POST", "/openyacht/v1/subscriptions", { callback }));
      expect(response.status).toBe(422);
      expect(schema("error")(await response.json())).toBe(true);
      expect(callbacks.size).toBe(0);
    },
  );

  it("is refused to a partner not approved here", async () => {
    const { handlers } = node({ trust: "provisional" });
    const response = await handlers.subscriptions(signed("POST", "/openyacht/v1/subscriptions", { callback: "https://partner.example/inbox" }));
    expect(response.status).toBe(403);
  });
});

describe("API-11 the inbox", () => {
  const document = listing(1, "2026-09-10T10:00:00Z", {}, SENDER);

  it("tells a partner this node did not subscribe to NOT_FOUND", async () => {
    const { handlers, applied } = node({ subscribed: false });
    expect((await handlers.inbox(signed("POST", "/openyacht/v1/inbox", document))).status).toBe(404);
    expect(applied).toEqual([]);
  });

  it("applies a pushed listing and reports the outcome", async () => {
    const { handlers, applied } = node({ subscribed: true });
    const response = await handlers.inbox(signed("POST", "/openyacht/v1/inbox", document));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "received", outcome: "created" });
    expect(applied.map((item) => item.canonicalUri)).toEqual([document.id]);
  });

  it("refuses a page, or a listing under another node's domain, with VALIDATION_ERROR", async () => {
    const { handlers, applied } = node({ subscribed: true });
    expect((await handlers.inbox(signed("POST", "/openyacht/v1/inbox", { data: [document], meta: {} }))).status).toBe(422);
    expect((await handlers.inbox(signed("POST", "/openyacht/v1/inbox", listing(2, "2026-09-10T10:00:00Z")))).status).toBe(422);
    expect(applied).toEqual([]);
  });
});

describe("API-11 deduplication against held state", () => {
  async function consumer() {
    const partners = new MemoryPartners();
    const copies = new MemoryCopies();
    const partner = await partners.create({
      domain: AUTHORITY,
      nodeUuid: NODE_UUID,
      nodeName: "Authority Yachts",
      trustLevel: "verified",
      keys: [publishedKey()],
      pinnedKeyId: null,
      acceptancePolicy: "accept_all",
    });
    const engine = new SyncEngine({
      client: clientFor(new FakeAuthority(AUTHORITY, () => ({ status: 500 }))),
      partners,
      copies,
      sanitiser: { sanitise: (html) => html },
      registry: { hasBuilder: () => true, hasCategory: () => true },
      clock,
    });
    return { engine, partner: partners.get(partner.id), copies };
  }

  it("drops a repeat of the state held, but not a re-shared listing that returns with its old updated_at", async () => {
    const { engine, partner, copies } = await consumer();
    const push = (document: Record<string, unknown>) => engine.applyDelivery(partner, parseFeedItem(document, AUTHORITY) as FeedItem);

    const shared = listing(1, "2026-09-10T10:00:00Z");
    expect(await push(shared)).toBe("created");
    expect(await push(shared)).toBe("duplicate");
    expect(await push(tombstone(1, "2026-09-11T10:00:00Z"))).toBe("tombstoned");
    expect(await push(tombstone(1, "2026-09-11T10:00:00Z"))).toBe("duplicate");
    // Re-shared: the listing comes back with the updated_at it had before.
    // A log of (id, updated_at) pairs received would drop it here.
    expect(await push(shared)).toBe("updated");
    expect(copies.rows.get(uri(1))!.tombstonedAt).toBeNull();
  });
});

describe("API-11 subscribing", () => {
  function service(features: Record<string, unknown>, route: ConstructorParameters<typeof FakeAuthority>[1] = () => ({ status: 204 })) {
    const partners = new MemoryPartners();
    const authority = new FakeAuthority(AUTHORITY, route);
    authority.capabilities = { protocol_versions: ["1.0"], features, limits: { page_size_max: 100, rate_per_hour: 500 } };
    const partnerService = new PartnerService({
      ownDomain: OWN_DOMAIN,
      partners,
      wellKnown: discovery({ keys: [publishedKey()] }),
      client: clientFor(authority),
      clock,
    });
    return { partnerService, partners, authority };
  }

  it("reads the partner's capabilities first, and leaves one that offers no pushes on polling", async () => {
    const { partnerService, partners, authority } = service({ subscriptions: false });
    const partner = await partnerService.add(AUTHORITY, { pinKey: false, acceptancePolicy: "hold" });
    expect(await partnerService.subscribe(partners.get(partner.id), "https://consumer.example/openyacht/v1/inbox")).toBe("not_offered");
    expect(authority.signed.filter((request) => request.path.endsWith("/subscriptions"))).toEqual([]);
    expect(partners.get(partner.id).pushSubscribedAt).toBeNull();
  });

  it("registers the inbox with a signed request, and always clears the record on leaving, reachable or not", async () => {
    let reachable = true;
    const { partnerService, partners, authority } = service({ subscriptions: true }, () =>
      reachable ? { status: 204 } : new Error("connection refused"),
    );
    const partner = await partnerService.add(AUTHORITY, { pinKey: false, acceptancePolicy: "hold" });
    expect(await partnerService.subscribe(partners.get(partner.id), "https://consumer.example/openyacht/v1/inbox")).toBe("subscribed");
    const registration = authority.signed.find((request) => request.path === "/openyacht/v1/subscriptions")!;
    expect(registration).toMatchObject({ method: "POST", verified: true, body: { callback: "https://consumer.example/openyacht/v1/inbox" } });
    expect(partners.get(partner.id).pushSubscribedAt).toEqual(NOW);

    reachable = false;
    expect(await partnerService.unsubscribe(partners.get(partner.id))).toMatchObject({ remote: "failed" });
    expect(partners.get(partner.id).pushSubscribedAt).toBeNull();
  });
});

describe("API-11 polling continues", () => {
  const HOUR = 3600_000;
  const base = { consecutiveFailures: 0, lastAttemptAt: NOW, lastOkAt: NOW };

  it("polls a subscribed partner once a day, and an unsubscribed one whenever asked", () => {
    expect(isSyncDue({ ...base, pushSubscribedAt: NOW }, new Date(NOW.getTime() + 23 * HOUR))).toBe(false);
    expect(isSyncDue({ ...base, pushSubscribedAt: NOW }, new Date(NOW.getTime() + 24 * HOUR))).toBe(true);
    expect(isSyncDue({ ...base, pushSubscribedAt: null }, new Date(NOW.getTime() + HOUR))).toBe(true);
  });
});
