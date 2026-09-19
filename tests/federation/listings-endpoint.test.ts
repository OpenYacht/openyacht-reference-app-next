// The authority's listings endpoints: a real Signer and the real Verifier on
// either side of the handler, a fake feed source behind it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decodeCursor,
  decodePublicKey,
  encodeCursor,
  FeedQueryError,
  generateKeypair,
  InMemoryRateLimiter,
  parseFeedQuery,
  serializeTombstone,
  Signer,
  Verifier,
  type FeedQuery,
  type ListingFeedSource,
  type OpenYachtListing,
  type PartnerRecord,
  type RateLimiter,
  type TrustLevel,
} from "@/federation";
import { createFederationHandlers } from "@/lib/federation/handlers";

const DOMAIN = "node.brokerage.example";
const PARTNER = "partner.example";
const NOW = new Date("2026-09-18T12:00:00Z");
const clock = { now: () => NOW };
const UUID = "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b";
const LIMITS = { pageSizeDefault: 50, pageSizeMax: 100 };

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  const dir = join(process.cwd(), "protocol/schemas/v1");
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")));
});
const valid = (schema: string, document: unknown) => {
  const validate = ajv.getSchema(`https://openyacht.org/schemas/v1/${schema}.schema.json`)!;
  validate(document);
  return validate.errors ?? [];
};

afterEach(() => vi.restoreAllMocks());

const example = JSON.parse(readFileSync(join(process.cwd(), "protocol/examples/valid/sale-full.json"), "utf8")) as OpenYachtListing;
const listing = { ...example, id: `https://${DOMAIN}/openyacht/v1/listings/${UUID}` };
const keys = generateKeypair();

function setup(trustLevel: TrustLevel, source: Partial<ListingFeedSource> = {}, rateLimiter?: RateLimiter) {
  const partner: PartnerRecord = {
    domain: PARTNER,
    nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd",
    trustLevel,
    keys: [{ keyId: keys.keyId, publicKey: decodePublicKey(keys.publicKey), createdAt: "2026-09-01T00:00:00Z" }],
    pinnedKeyId: null,
  };
  const queries: { domain: string; query: FeedQuery }[] = [];
  const handlers = createFederationHandlers({
    identity: () => ({ domain: DOMAIN, name: "Example Yacht Brokerage", website: null }),
    store: {
      getState: async () => ({ nodeUuid: partner.nodeUuid, identityDomain: DOMAIN, setupCompleted: true }),
      listPublishedKeys: async () => [],
    },
    clock,
    software: "test",
    requestId: () => "req_test",
    inbound: {
      verify: (request) =>
        new Verifier({
          ownDomain: DOMAIN,
          clock,
          partners: { findByDomain: async () => partner, updateCachedKeys: async () => {}, downgradeToProvisional: async () => {} },
          wellKnown: { fetchFresh: async () => ({ nodeUuid: partner.nodeUuid, name: "Partner", keys: partner.keys }) },
        }).verify(request),
      recordPartnerRequest: async () => {},
      log: async () => {},
    },
    rateLimiter,
    listings: {
      page: async (domain, query) => {
        queries.push({ domain, query });
        return { items: [listing], next: null };
      },
      one: async () => null,
      ...source,
    },
  });
  return { handlers, queries };
}

function signedGet(pathAndQuery: string) {
  const url = new URL(`https://${DOMAIN}${pathAndQuery}`);
  return new Request(url, { headers: { ...new Signer(PARTNER, keys, clock).sign({ method: "GET", url }), host: DOMAIN } });
}

describe("API-2 the opaque cursor", () => {
  it("round-trips a position at the database's full precision", () => {
    const position = { at: "2026-09-18T20:41:07.456123Z", id: "42" };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(encodeCursor(position)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["garbage", "!!!"],
    ["valid base64, not JSON", Buffer.from("nope").toString("base64url")],
    ["the wrong shape", Buffer.from('{"at":"x"}').toString("base64url")],
    ["a timestamp that is not one", Buffer.from('["yesterday","42"]').toString("base64url")],
    ["an id that is not a number", Buffer.from('["2026-09-18T20:41:07.456123Z","1; drop table listings"]').toString("base64url")],
  ])("refuses %s — a cursor comes back from outside and is validated like any input", (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(FeedQueryError);
  });
});

describe("API-2 query parameters", () => {
  const parse = (query: string) => parseFeedQuery(new URLSearchParams(query), LIMITS);

  it("a cold sync has no updated_since, no cursor, and the default page size", () => {
    expect(parse("")).toEqual({ since: null, after: null, pageSize: 50 });
  });

  it("passes updated_since through verbatim", () => {
    expect(parse("updated_since=2026-08-01T00:00:00Z&page_size=25")).toEqual({ since: "2026-08-01T00:00:00Z", after: null, pageSize: 25 });
  });

  it("caps page_size at the advertised maximum rather than refusing", () => {
    expect(parse("page_size=5000").pageSize).toBe(100);
  });

  it.each([
    "updated_since=yesterday",
    "updated_since=2026-08-01T00:00:00%2B02:00",
    "updated_since=2026-08-01",
    "page_size=0",
    "page_size=-5",
    "page_size=ten",
    "cursor=!!!",
  ])("refuses %s", (query) => {
    expect(() => parse(query)).toThrow(FeedQueryError);
  });
});

describe("GET /openyacht/v1/listings", () => {
  it("serves a schema-valid collection to a verified partner, asking storage for that partner's view", async () => {
    const { handlers, queries } = setup("verified");
    const response = await handlers.listings(signedGet("/openyacht/v1/listings?updated_since=2026-08-01T00:00:00Z&page_size=50"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(valid("collection", body)).toEqual([]);
    expect(body.meta).toEqual({ generated_at: "2026-09-18T12:00:00Z", protocol_version: "1.0" });
    expect(queries).toEqual([{ domain: PARTNER, query: { since: "2026-08-01T00:00:00Z", after: null, pageSize: 50 } }]);
  });

  it("next_cursor is present while there is more, and absent — not null — on the last page", async () => {
    const position = { at: "2026-09-18T20:41:07.456123Z", id: "42" };
    const more = setup("verified", { page: async () => ({ items: [listing], next: position }) });
    const first = await (await more.handlers.listings(signedGet("/openyacht/v1/listings"))).json();
    expect(decodeCursor(first.meta.next_cursor)).toEqual(position);
    expect(valid("collection", first)).toEqual([]);

    const last = await (await setup("verified").handlers.listings(signedGet("/openyacht/v1/listings"))).json();
    expect("next_cursor" in last.meta).toBe(false);
  });

  it("a returned cursor is accepted back", async () => {
    const { handlers, queries } = setup("verified");
    const cursor = encodeCursor({ at: "2026-09-18T20:41:07.456123Z", id: "42" });
    await handlers.listings(signedGet(`/openyacht/v1/listings?cursor=${cursor}`));
    expect(queries[0]!.query.after).toEqual({ at: "2026-09-18T20:41:07.456123Z", id: "42" });
  });

  it("serves listings and tombstones in one page", async () => {
    const tombstone = serializeTombstone(DOMAIN, "018f6d2e-9f0a-7cc3-a1b2-000000000002", "sold", NOW);
    const { handlers } = setup("verified", { page: async () => ({ items: [listing, tombstone], next: null }) });
    const body = await (await handlers.listings(signedGet("/openyacht/v1/listings"))).json();
    expect(valid("collection", body)).toEqual([]);
    expect(body.data.map((item: { tombstone?: boolean }) => item.tombstone === true)).toEqual([false, true]);
  });

  it("FP-13: a provisional partner is authenticated and told PARTNER_PROVISIONAL — and storage is never asked", async () => {
    const { handlers, queries } = setup("provisional");
    const response = await handlers.listings(signedGet("/openyacht/v1/listings"));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(valid("error", body)).toEqual([]);
    expect(body.error.code).toBe("PARTNER_PROVISIONAL");
    expect(queries).toEqual([]);
  });

  it("an unsigned request is SIGNATURE_INVALID", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await setup("verified").handlers.listings(new Request(`https://${DOMAIN}/openyacht/v1/listings`, { headers: { host: DOMAIN } }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SIGNATURE_INVALID");
  });

  it.each(["updated_since=yesterday", "page_size=0", "cursor=!!!"])("a bad query (%s) is VALIDATION_ERROR, 422", async (query) => {
    const response = await setup("verified").handlers.listings(signedGet(`/openyacht/v1/listings?${query}`));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(valid("error", body)).toEqual([]);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /openyacht/v1/listings/{uuid}", () => {
  it("serves the listing a partner may see", async () => {
    const { handlers } = setup("verified", { one: async () => listing });
    const response = await handlers.listing(signedGet(`/openyacht/v1/listings/${UUID}`), UUID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(valid("listing", body)).toEqual([]);
    expect(body.id).toBe(`https://${DOMAIN}/openyacht/v1/listings/${UUID}`);
  });

  it("answers NOT_FOUND identically for a listing that is unshared, a draft, unknown, or not a UUID at all", async () => {
    const { handlers } = setup("verified", { one: async () => null });
    const bodies = [];
    for (const uuid of [UUID, "018f6d2e-9f0a-7cc3-a1b2-ffffffffffff", "not-a-uuid"]) {
      const response = await handlers.listing(signedGet(`/openyacht/v1/listings/${uuid}`), uuid);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }
    expect(valid("error", bodies[0])).toEqual([]);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("answers GONE for a listing that ended longer ago than the retention period", async () => {
    const { handlers } = setup("verified", { one: async () => "gone" });
    const response = await handlers.listing(signedGet(`/openyacht/v1/listings/${UUID}`), UUID);
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(valid("error", body)).toEqual([]);
    expect(body.error.code).toBe("GONE");
  });

  it("FP-13: a provisional partner dereferences nothing", async () => {
    let asked = false;
    const { handlers } = setup("provisional", {
      one: async () => {
        asked = true;
        return listing;
      },
    });
    const response = await handlers.listing(signedGet(`/openyacht/v1/listings/${UUID}`), UUID);
    expect(response.status).toBe(403);
    expect(asked).toBe(false);
  });
});

describe("API-9 RATE_LIMITED", () => {
  /** Refuses everything after the first `allowance` requests, and remembers whom it was asked about. */
  function limiter(allowance: number) {
    const asked: string[] = [];
    const limiter: RateLimiter = {
      async take(key) {
        asked.push(key);
        return asked.length > allowance ? { allowed: false, retryAfterSeconds: 8 } : { allowed: true };
      },
    };
    return { limiter, asked };
  }

  it("answers 429 with Retry-After and a schema-valid envelope — and storage is never asked", async () => {
    const { limiter: rateLimiter } = limiter(1);
    const { handlers, queries } = setup("verified", {}, rateLimiter);
    expect((await handlers.listings(signedGet("/openyacht/v1/listings"))).status).toBe(200);

    const response = await handlers.listings(signedGet("/openyacht/v1/listings?page_size=10"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
    const body = await response.json();
    expect(valid("error", body)).toEqual([]);
    expect(body.error).toMatchObject({ code: "RATE_LIMITED", details: { retry_after_seconds: 8 } });
    expect(queries).toHaveLength(1);
  });

  it("counts against the verified partner, never against a domain that was merely claimed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { limiter: rateLimiter, asked } = limiter(100);
    const { handlers } = setup("verified", {}, rateLimiter);
    // Unsigned, and claiming to be the partner: rejected before the limiter hears of it.
    const forged = new Request(`https://${DOMAIN}/openyacht/v1/listings`, { headers: { host: DOMAIN, "X-OpenYacht-Node": PARTNER } });
    expect((await handlers.listings(forged)).status).toBe(401);
    expect(asked).toEqual([]);

    await handlers.listings(signedGet("/openyacht/v1/listings"));
    expect(asked).toEqual([PARTNER]);
  });

  it("a provisional partner is limited too: authenticated is enough to be counted", async () => {
    const { limiter: rateLimiter } = limiter(0);
    const response = await setup("provisional", {}, rateLimiter).handlers.listings(signedGet("/openyacht/v1/listings"));
    expect(response.status).toBe(429);
  });

  it("enforces what capabilities advertises: 500 an hour, available as one burst", async () => {
    const { handlers } = setup("verified", {}, new InMemoryRateLimiter(clock));
    const capabilities = await (
      await handlers.capabilities(new Request(`https://${DOMAIN}/openyacht/v1/capabilities`, { headers: { host: DOMAIN } }))
    ).json();
    expect(capabilities.limits.rate_per_hour).toBe(500);

    // Distinct requests: a byte-identical one inside the window would be a replay, not a rate question.
    const statuses = new Set<number>();
    for (let request = 0; request < 500; request++)
      statuses.add((await handlers.listing(signedGet(`/openyacht/v1/listings/${UUID}?n=${request}`), UUID)).status);
    expect([...statuses]).toEqual([404]);
    const refused = await handlers.listing(signedGet(`/openyacht/v1/listings/${UUID}?n=500`), UUID);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
