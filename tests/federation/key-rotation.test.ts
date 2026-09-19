// A key rotation as a partner lives through it. This node's real handlers
// publish whatever keys storage says are published; a partner's real Verifier
// holds a cache of them and refetches from those handlers.
// Spec: federation-protocol.md §Key Rotation.
import { describe, expect, it } from "vitest";
import {
  decodePublicKey,
  generateKeypair,
  parseNodeIdentity,
  parseWellKnownDocument,
  Signer,
  Verifier,
  type OwnPublishedKey,
  type PartnerRecord,
  type PublishedKey,
} from "@/federation";
import { createFederationHandlers } from "@/lib/federation/handlers";

const NODE = "node.brokerage.example";
const PARTNER = "partner.example";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";
const clock = { now: () => new Date("2026-09-19T12:00:00Z") };

type Keypair = ReturnType<typeof generateKeypair>;
const own = (key: Keypair): OwnPublishedKey => ({ keyId: key.keyId, publicKey: key.publicKey, createdAt: "2026-09-19T11:00:00Z" });

function drill(options: { cached: Keypair[]; pinned?: Keypair }) {
  // What this node publishes: the test changes it as a rotation would.
  const node = { published: [] as Keypair[] };
  const handlers = createFederationHandlers({
    identity: () => parseNodeIdentity({ OPENYACHT_DOMAIN: NODE, OPENYACHT_NODE_NAME: "Example Yacht Brokerage" }),
    store: {
      getState: async () => ({ nodeUuid: NODE_UUID, identityDomain: NODE, setupCompleted: true }),
      listPublishedKeys: async () => node.published.map(own),
    },
    clock,
    software: "test",
    requestId: () => "req_test",
  });

  // The partner's record of this node, and its verifier.
  const record: PartnerRecord = {
    domain: NODE,
    nodeUuid: NODE_UUID,
    trustLevel: "verified",
    keys: options.cached.map((key): PublishedKey => ({
      keyId: key.keyId,
      publicKey: decodePublicKey(key.publicKey),
      createdAt: "2026-09-19T11:00:00Z",
    })),
    pinnedKeyId: options.pinned?.keyId ?? null,
  };
  let refetches = 0;
  const verifier = new Verifier({
    ownDomain: PARTNER,
    clock,
    partners: {
      findByDomain: async () => record,
      updateCachedKeys: async (_domain, keys) => void (record.keys = keys),
      downgradeToProvisional: async () => {},
    },
    wellKnown: {
      async fetchFresh() {
        refetches++;
        const response = await handlers.wellKnown(new Request(`https://${NODE}/.well-known/openyacht`, { headers: { host: NODE } }));
        return parseWellKnownDocument(await response.json());
      },
    },
  });

  /** This node polls the partner, signing with `key`. */
  const poll = (key: Keypair) => {
    const url = new URL(`https://${PARTNER}/openyacht/v1/listings?updated_since=2026-09-01T00:00:00Z`);
    const headers = new Headers(new Signer(NODE, key, clock).sign({ method: "GET", url }));
    return verifier.verify({ method: "GET", pathAndQuery: url.pathname + url.search, headers, body: new Uint8Array() });
  };
  return { node, poll, cachedKeyIds: () => record.keys.map((key) => key.keyId), refetches: () => refetches };
}

describe("FP-10 routine rotation: no coordination, no outage", () => {
  it("a partner holding only the old key accepts the new one after a single refetch, and the old one throughout the overlap", async () => {
    const [oldKey, newKey] = [generateKeypair(), generateKeypair()];
    const { node, poll, cachedKeyIds, refetches } = drill({ cached: [oldKey] });
    node.published = [newKey, oldKey];

    expect(await poll(newKey)).toMatchObject({ ok: true, keyId: newKey.keyId });
    expect(refetches()).toBe(1);
    expect(cachedKeyIds()).toEqual([newKey.keyId, oldKey.keyId]);

    // A request signed a moment before the rotation is still in flight.
    expect(await poll(oldKey)).toMatchObject({ ok: true });
    expect(await poll(newKey)).toMatchObject({ ok: true });
    expect(refetches()).toBe(1);
  });

  it("once the overlap has ended the old key is gone from what partners learn", async () => {
    const [oldKey, newKey] = [generateKeypair(), generateKeypair()];
    const { node, poll, cachedKeyIds } = drill({ cached: [] });
    node.published = [newKey];
    expect(await poll(newKey)).toMatchObject({ ok: true });
    expect(cachedKeyIds()).toEqual([newKey.keyId]);
    expect(await poll(oldKey)).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});

describe("emergency rotation: no overlap", () => {
  it("the partner's next verification refetches and recovers by itself — and the old key stops working there", async () => {
    const [stolen, replacement] = [generateKeypair(), generateKeypair()];
    const { node, poll, cachedKeyIds, refetches } = drill({ cached: [stolen] });
    node.published = [replacement];

    expect(await poll(replacement)).toMatchObject({ ok: true, keyId: replacement.keyId });
    expect(refetches()).toBe(1);
    // The refetch replaced the partner's cache, so whoever holds the old key can no longer use it here.
    expect(cachedKeyIds()).toEqual([replacement.keyId]);
    expect(await poll(stolen)).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});

describe("FP-12 a partner that pinned the old key", () => {
  it("does not follow the rotation by itself: its administrator confirms the new key", async () => {
    const [oldKey, newKey] = [generateKeypair(), generateKeypair()];
    const { node, poll } = drill({ cached: [oldKey], pinned: oldKey });
    node.published = [newKey, oldKey];
    expect(await poll(newKey)).toMatchObject({ ok: false });
    // The pinned key goes on working for as long as it is published.
    expect(await poll(oldKey)).toMatchObject({ ok: true });
  });
});
