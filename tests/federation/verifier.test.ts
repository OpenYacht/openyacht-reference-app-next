// The verifier accepts both published vectors and
// rejects all five negative tests of protocol/spec/signing-test-vectors.md.
import { describe, expect, it } from "vitest";
import {
  decodePublicKey,
  generateKeypair,
  InMemoryReplayGuard,
  Signer,
  Verifier,
  type DiscoveredNode,
  type InboundRequest,
  type PartnerRecord,
  type PartnerStore,
  type PublishedKey,
  type TrustLevel,
  type WellKnownSource,
} from "@/federation";
import { RECEIVER, SENDER, TEST_KEY, VECTOR_1, VECTOR_2 } from "./vectors";

const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";
const OTHER_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abce";
const testKey: PublishedKey = {
  keyId: TEST_KEY.keyId,
  publicKey: decodePublicKey(TEST_KEY.publicKey),
  createdAt: "2026-08-20T10:30:00Z",
};

/** A harness around one partner record, recording everything the verifier does to it. */
function harness(options: { now: string; partner?: Partial<PartnerRecord> | null; fresh?: DiscoveredNode | Error; replayGuard?: boolean }) {
  const partner: PartnerRecord | null =
    options.partner === null
      ? null
      : { domain: SENDER, nodeUuid: NODE_UUID, trustLevel: "verified", keys: [testKey], pinnedKeyId: null, ...options.partner };
  const calls = { lookups: 0, refetches: 0, cachedKeys: null as PublishedKey[] | null, downgraded: false, notified: false };
  const rejections: string[] = [];

  const partners: PartnerStore = {
    async findByDomain(domain) {
      calls.lookups++;
      return partner !== null && domain === partner.domain ? partner : null;
    },
    async updateCachedKeys(_domain, keys) {
      calls.cachedKeys = keys;
    },
    async downgradeToProvisional() {
      calls.downgraded = true;
    },
  };
  const wellKnown: WellKnownSource = {
    async fetchFresh() {
      calls.refetches++;
      const fresh = options.fresh ?? { nodeUuid: NODE_UUID, name: "Sender", keys: partner?.keys ?? [] };
      if (fresh instanceof Error) throw fresh;
      return fresh;
    },
  };
  const verifier = new Verifier({
    ownDomain: RECEIVER,
    partners,
    wellKnown,
    clock: { now: () => new Date(options.now) },
    replayGuard: options.replayGuard ? new InMemoryReplayGuard({ now: () => new Date(options.now) }) : undefined,
    observer: {
      nodeUuidChanged: () => void (calls.notified = true),
      rejected: (event) => void rejections.push(event.code),
    },
  });
  return { verifier, calls, rejections };
}

function request(vector: typeof VECTOR_1 | typeof VECTOR_2, overrides: Partial<Record<string, string>> = {}): InboundRequest {
  const headers = new Headers({
    "X-OpenYacht-Node": SENDER,
    "X-OpenYacht-Key": TEST_KEY.keyId,
    "X-OpenYacht-Timestamp": vector.timestamp,
    "X-OpenYacht-Signature": vector.signature,
  });
  let pathAndQuery = vector.pathAndQuery;
  let body = vector.body;
  for (const [name, value] of Object.entries(overrides)) {
    if (name === "pathAndQuery") pathAndQuery = value!;
    else if (name === "body") body = value!;
    else if (value === "") headers.delete(name);
    else headers.set(name, value!);
  }
  return { method: vector.method, pathAndQuery, headers, body: Buffer.from(body, "utf8") };
}

describe("FP-7 the verifier accepts the published vectors", () => {
  it("vector 1 — bodyless GET", async () => {
    const { verifier, calls } = harness({ now: VECTOR_1.timestamp });
    const result = await verifier.verify(request(VECTOR_1));
    expect(result).toMatchObject({ ok: true, keyId: TEST_KEY.keyId });
    expect(calls.refetches).toBe(0);
  });

  it("vector 2 — POST with JSON body", async () => {
    const { verifier } = harness({ now: VECTOR_2.timestamp });
    expect(await verifier.verify(request(VECTOR_2))).toMatchObject({ ok: true });
  });

  it("accepts a timestamp exactly 300 seconds from server time", async () => {
    const { verifier } = harness({ now: "2026-08-21T09:05:00Z" });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: true });
  });
});

describe("signing-test-vectors.md negative tests", () => {
  it("1 (FP-7): a single changed byte of the signing string — page_size=51", async () => {
    const { verifier, calls, rejections } = harness({ now: VECTOR_1.timestamp });
    const result = await verifier.verify(request(VECTOR_1, { pathAndQuery: VECTOR_1.pathAndQuery.replace("page_size=50", "page_size=51") }));
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(calls.refetches).toBe(1);
    expect(rejections).toEqual(["SIGNATURE_INVALID"]);
  });

  it("2 (FP-7): the header timestamp differs from the signed one", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp });
    const result = await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Timestamp": "2026-08-21T09:00:01Z" }));
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("3 (FP-8): a validly signed timestamp outside ±300 s is rejected before any signature check", async () => {
    const { verifier, calls } = harness({ now: "2026-08-21T09:05:01Z" });
    const result = await verifier.verify(request(VECTOR_1));
    expect(result).toMatchObject({ ok: false, code: "TIMESTAMP_OUT_OF_RANGE" });
    // The signature is genuine, so only the window can have decided this —
    // and it did so without a key ever being looked up or refetched.
    expect(calls.lookups).toBe(0);
    expect(calls.refetches).toBe(0);
  });

  it("3 (FP-8): the window applies to timestamps in the future as well", async () => {
    const { verifier } = harness({ now: "2026-08-21T08:54:59Z" });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "TIMESTAMP_OUT_OF_RANGE" });
  });

  it("4 (FP-7): a body altered after signing — one extra space in the JSON", async () => {
    const { verifier } = harness({ now: VECTOR_2.timestamp });
    const result = await verifier.verify(request(VECTOR_2, { body: VECTOR_2.body.replace('{"message":', '{"message": ') }));
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("5 (FP-10): an unlisted key ID is rejected after exactly one fresh refetch", async () => {
    const { verifier, calls } = harness({ now: VECTOR_1.timestamp });
    const result = await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Key": "0000000000000000" }));
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(calls.refetches).toBe(1);
    expect(calls.cachedKeys).toBeNull();
  });
});

describe("FP-10 refetch and retry", () => {
  it("recovers from a rotated key with one refetch and caches the fresh keys", async () => {
    const rotated = generateKeypair();
    const rotatedKey: PublishedKey = { keyId: rotated.keyId, publicKey: decodePublicKey(rotated.publicKey), createdAt: "2026-08-21T08:00:00Z" };
    const signer = new Signer(SENDER, rotated, { now: () => new Date(VECTOR_1.timestamp) });
    const url = new URL(`https://${RECEIVER}${VECTOR_1.pathAndQuery}`);
    const { verifier, calls } = harness({
      now: VECTOR_1.timestamp,
      fresh: { nodeUuid: NODE_UUID, name: "Sender", keys: [rotatedKey, testKey] },
    });

    const result = await verifier.verify({
      method: "GET",
      pathAndQuery: VECTOR_1.pathAndQuery,
      headers: new Headers(signer.sign({ method: "GET", url })),
      body: new Uint8Array(0),
    });

    expect(result).toMatchObject({ ok: true, keyId: rotated.keyId });
    expect(calls.refetches).toBe(1);
    expect(calls.cachedKeys).toEqual([rotatedKey, testKey]);
  });

  it("rejects when the well-known document cannot be refetched", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, fresh: new Error("unreachable") });
    const result = await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Key": "0000000000000000" }));
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});

describe("FP-9 blocked partners", () => {
  it("rejects a blocked partner even with a valid signature", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, partner: { trustLevel: "blocked" } });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "PARTNER_BLOCKED" });
  });

  it.each<TrustLevel>(["verified", "provisional"])("authenticates a %s partner and reports its trust level", async (trustLevel) => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, partner: { trustLevel } });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: true, partner: { trustLevel } });
  });
});

describe("FP-11 node UUID change", () => {
  it("downgrades the partner, notifies administrators and rejects", async () => {
    const { verifier, calls } = harness({
      now: VECTOR_1.timestamp,
      partner: { keys: [] },
      fresh: { nodeUuid: OTHER_UUID, name: "Sender", keys: [testKey] },
    });
    // The signature would verify against the fresh key: the UUID change wins.
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(calls.downgraded).toBe(true);
    expect(calls.notified).toBe(true);
    expect(calls.cachedKeys).toBeNull();
  });
});

describe("FP-12 pinned keys", () => {
  it("accepts the pinned key", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, partner: { pinnedKeyId: TEST_KEY.keyId } });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: true });
  });

  it("rejects a correctly signed request from another published key until an administrator confirms", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, partner: { pinnedKeyId: "ffffffffffffffff" } });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});

describe("FP-13 senders the verifier will not look up", () => {
  it("reports an unknown domain as PARTNER_UNKNOWN", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, partner: null });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "PARTNER_UNKNOWN" });
  });

  it("rejects a request naming this node's own domain before any lookup", async () => {
    const { verifier, calls } = harness({ now: VECTOR_1.timestamp });
    expect(await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Node": RECEIVER }))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(calls.lookups).toBe(0);
  });

  it.each(["169.254.169.254", "127.0.0.1:6379", "sender.example/path?x", "localhost", "[::1]"])(
    "never fetches for the malformed sender %s",
    async (node) => {
      const { verifier, calls } = harness({ now: VECTOR_1.timestamp });
      expect(await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Node": node }))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
      expect(calls.lookups + calls.refetches).toBe(0);
    },
  );

  it("rejects a request missing a signature header", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp });
    expect(await verifier.verify(request(VECTOR_1, { "X-OpenYacht-Signature": "" }))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});

describe("FP-13 first contact from an unknown domain", () => {
  function firstContactHarness(fresh: DiscoveredNode | Error) {
    const registered: string[] = [];
    const notified: string[] = [];
    let refetches = 0;
    const verifier = new Verifier({
      ownDomain: RECEIVER,
      clock: { now: () => new Date(VECTOR_1.timestamp) },
      partners: {
        findByDomain: async () => null,
        updateCachedKeys: async () => {},
        downgradeToProvisional: async () => {},
        registerFirstContact: async (domain, discovered) => {
          registered.push(domain);
          return { domain, nodeUuid: discovered.nodeUuid, trustLevel: "provisional", keys: discovered.keys, pinnedKeyId: null };
        },
      },
      wellKnown: {
        fetchFresh: async () => {
          refetches++;
          if (fresh instanceof Error) throw fresh;
          return fresh;
        },
      },
      observer: { firstContact: (event) => void notified.push(event.domain) },
    });
    return { verifier, registered, notified, refetches: () => refetches };
  }

  it("registers the sender as provisional, and tells administrators, once its signature verifies against its published keys", async () => {
    const { verifier, registered, notified } = firstContactHarness({ nodeUuid: NODE_UUID, name: "Sender", keys: [testKey] });
    const result = await verifier.verify(request(VECTOR_1));
    expect(result).toMatchObject({ ok: true, partner: { domain: SENDER, trustLevel: "provisional" } });
    expect(registered).toEqual([SENDER]);
    expect(notified).toEqual([SENDER]);
  });

  it("registers nothing when the signature does not verify — a domain name in a header proves nothing", async () => {
    const { verifier, registered, notified } = firstContactHarness({ nodeUuid: NODE_UUID, name: "Sender", keys: [testKey] });
    const forged = request(VECTOR_1, { pathAndQuery: "/openyacht/v1/listings?page_size=1" });
    expect(await verifier.verify(forged)).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(registered).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("answers PARTNER_UNKNOWN when the sender's well-known document cannot be fetched", async () => {
    const { verifier, registered } = firstContactHarness(new Error("refused: not a public address"));
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "PARTNER_UNKNOWN" });
    expect(registered).toEqual([]);
  });

  it("checks the timestamp window before fetching anything for an unknown sender", async () => {
    const context = firstContactHarness({ nodeUuid: NODE_UUID, name: "Sender", keys: [testKey] });
    const late = new Verifier({
      ownDomain: RECEIVER,
      clock: { now: () => new Date("2026-08-21T10:00:00Z") },
      partners: {
        findByDomain: async () => null,
        updateCachedKeys: async () => {},
        downgradeToProvisional: async () => {},
        registerFirstContact: async () => {
          throw new Error("must not register");
        },
      },
      wellKnown: {
        fetchFresh: async () => {
          throw new Error("must not fetch");
        },
      },
    });
    expect(await late.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "TIMESTAMP_OUT_OF_RANGE" });
    expect(context.refetches()).toBe(0);
  });
});

describe("replay protection (SHOULD, verification step 1)", () => {
  it("rejects an exact duplicate inside the window, and only remembers verified requests", async () => {
    const { verifier } = harness({ now: VECTOR_1.timestamp, replayGuard: true });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: true });
    expect(await verifier.verify(request(VECTOR_1))).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });
});
