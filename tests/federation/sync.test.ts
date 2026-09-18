// The consumer's sync engine: cold sync, `updated_since` polling, tombstones,
// copies and their provenance, acceptance policy, conflicts and staleness.
import { describe, expect, it } from "vitest";
import { isSyncDue, nextAttemptAt, partnerFreshness, SyncEngine, type AcceptancePolicy, type Partner, type TrustLevel } from "@/federation";
import {
  AUTHORITY,
  clientFor,
  clock,
  errorEnvelope,
  FakeAuthority,
  listing,
  MemoryCopies,
  MemoryPartners,
  NOW,
  page,
  publishedKey,
  tombstone,
  uri,
} from "./support/consumer-harness";

type Route = ConstructorParameters<typeof FakeAuthority>[1];

// Stands in for the real sanitiser, which lives outside the core: enough to
// prove the engine sanitises on receipt and stores the result.
const sanitiser = { sanitise: (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "") };
const registry = { hasBuilder: (slug: string) => slug === "maritimo", hasCategory: (slug: string) => slug === "motor-yacht" };

async function setup(route: Route, options: { policy?: AcceptancePolicy; trustLevel?: TrustLevel; domain?: string } = {}) {
  const partners = new MemoryPartners();
  const copies = new MemoryCopies();
  const domain = options.domain ?? AUTHORITY;
  const authority = new FakeAuthority(domain, route);
  const partner = await partners.create({
    domain,
    nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd",
    nodeName: "Authority Yachts",
    trustLevel: options.trustLevel ?? "verified",
    keys: [publishedKey()],
    pinnedKeyId: null,
    acceptancePolicy: options.policy ?? "accept_all",
  });
  const engine = new SyncEngine({ client: clientFor(authority), partners, copies, sanitiser, registry, clock });
  const sync = () => engine.syncPartner(partners.get(partner.id));
  return { partners, copies, authority, partner, engine, sync };
}

describe("API-2 cold sync", () => {
  it("sends no updated_since, follows the opaque cursor to the last page, and signs every request", async () => {
    const { authority, copies, sync } = await setup((request) =>
      request.query.get("cursor") === null
        ? { status: 200, json: page([listing(1, "2026-09-01T10:00:00Z"), listing(2, "2026-09-02T10:00:00Z")], "opaque-cursor-1") }
        : { status: 200, json: page([listing(3, "2026-09-03T10:00:00Z")]) },
    );

    expect(await sync()).toMatchObject({ status: "synced", pages: 2, created: 3 });
    expect(authority.signed).toHaveLength(2);
    expect(authority.signed.every((request) => request.verified)).toBe(true);
    expect(authority.signed[0]!.query.has("updated_since")).toBe(false);
    expect(authority.signed[1]!.query.get("cursor")).toBe("opaque-cursor-1");
    expect(copies.rows.size).toBe(3);
  });

  it("API-7: asks for no more than the partner's advertised page_size_max", async () => {
    const context = await setup(() => ({ status: 200, json: page([]) }));
    context.authority.capabilities = { protocol_versions: ["1.0"], features: {}, limits: { page_size_max: 25, rate_per_hour: 500 } };
    await context.sync();
    expect(context.authority.signed[0]!.query.get("page_size")).toBe("25");
  });

  it("fails rather than loop when the partner's cursor never ends", async () => {
    const { sync, partners, partner } = await setup(() => ({ status: 200, json: page([], "same-cursor") }));
    expect(await sync()).toMatchObject({ status: "failed" });
    expect(partners.get(partner.id).consecutiveFailures).toBe(1);
  });
});

describe("ID-3 provenance on every copy", () => {
  it("records the canonical URI, the authority, the receipt time and the verification", async () => {
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z")]) }));
    await sync();
    expect(copies.rows.get(uri(1))).toMatchObject({
      canonicalUri: uri(1),
      type: "sale",
      status: "active",
      provenance: { canonical: uri(1), authority: AUTHORITY, received_at: "2026-09-18T12:00:00Z", signature_verified: true },
    });
  });

  it("ID-5: stores the payload as the authority sent it", async () => {
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z")]) }));
    await sync();
    expect(copies.rows.get(uri(1))!.payload).toEqual(listing(1, "2026-09-01T10:00:00Z"));
  });
});

describe("ID-1 / ID-6 a partner delivers only its own listings", () => {
  it("rejects a listing whose canonical URI is under another domain, and keeps the rest of the page", async () => {
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page([listing(1, "2026-09-01T10:00:00Z"), listing(2, "2026-09-01T11:00:00Z", {}, "someone-else.example")]),
    }));
    expect(await sync()).toMatchObject({ status: "synced", created: 1, rejected: 1 });
    expect([...copies.rows.keys()]).toEqual([uri(1)]);
  });

  it.each([
    ["a draft", { status: "draft" }],
    ["an invented status", { status: "pending" }],
    ["a local-time timestamp", { updated_at: "2026-09-01T10:00:00+02:00" }],
    ["an unknown type", { type: "auction" }],
  ])("LS-7 / API-1: rejects %s", async (_label, overrides) => {
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z", overrides)]) }));
    expect(await sync()).toMatchObject({ status: "synced", rejected: 1 });
    expect(copies.rows.size).toBe(0);
  });

  it("API-8: accepts a listing carrying fields this node does not know", async () => {
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page([listing(1, "2026-09-01T10:00:00Z", { a_field_from_protocol_1_1: { anything: true }, x_private: 1 })]),
    }));
    expect(await sync()).toMatchObject({ created: 1, rejected: 0 });
    expect(copies.rows.get(uri(1))!.payload).toHaveProperty("a_field_from_protocol_1_1");
  });
});

describe("API-3 / ID-7 delta polling", () => {
  it("polls from the newest updated_at it has seen, and applies one update and one tombstone", async () => {
    let poll = 0;
    const { authority, copies, partners, partner, sync } = await setup(() => {
      poll++;
      return poll === 1
        ? { status: 200, json: page([listing(1, "2026-09-01T10:00:00Z"), listing(2, "2026-09-02T10:00:00Z")]) }
        : { status: 200, json: page([listing(1, "2026-09-05T09:00:00Z", { status: "under_offer" }), tombstone(2, "2026-09-05T09:30:00Z")]) };
    });

    await sync();
    expect(partners.get(partner.id).syncWatermark).toBe("2026-09-02T10:00:00Z");

    expect(await sync()).toMatchObject({ status: "synced", updated: 1, tombstoned: 1 });
    expect(authority.signed[1]!.query.get("updated_since")).toBe("2026-09-02T10:00:00Z");
    expect(copies.rows.get(uri(1))).toMatchObject({ status: "under_offer", updatedAt: "2026-09-05T09:00:00Z", tombstonedAt: null });
    expect(partners.get(partner.id)).toMatchObject({ syncWatermark: "2026-09-05T09:30:00Z", lastOkAt: NOW, consecutiveFailures: 0 });
  });

  it("ID-7 / ID-10: a tombstone ends all use of the data — the payload is dropped, not hidden", async () => {
    let poll = 0;
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page(++poll === 1 ? [listing(1, "2026-09-01T10:00:00Z")] : [tombstone(1, "2026-09-05T09:30:00Z", "sold")]),
    }));
    await sync();
    await sync();
    expect(copies.rows.get(uri(1))).toMatchObject({ payload: null, status: "sold", tombstonedAt: "2026-09-05T09:30:00Z", displayState: "held" });
    // Provenance survives: what was held, from whom, remains answerable.
    expect(copies.rows.get(uri(1))!.provenance.authority).toBe(AUTHORITY);
  });

  it("treats a full payload with a terminal status exactly like a tombstone", async () => {
    let poll = 0;
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page([listing(1, ++poll === 1 ? "2026-09-01T10:00:00Z" : "2026-09-06T10:00:00Z", { status: poll === 1 ? "active" : "withdrawn" })]),
    }));
    await sync();
    expect(await sync()).toMatchObject({ tombstoned: 1 });
    expect(copies.rows.get(uri(1))!.payload).toBeNull();
  });

  it("restores a re-shared listing even though its updated_at is older than the tombstone it replaces", async () => {
    const pages = [
      [listing(1, "2026-09-01T10:00:00Z")],
      [tombstone(1, "2026-09-05T09:30:00Z")], // unshared: stamped at the moment of unsharing
      [listing(1, "2026-09-01T10:00:00Z")], // shared again: the listing itself never changed
    ];
    const { copies, sync } = await setup(() => ({ status: 200, json: page(pages.shift()!) }));
    await sync();
    await sync();
    expect(copies.rows.get(uri(1))!.tombstonedAt).not.toBeNull();
    expect(await sync()).toMatchObject({ updated: 1 });
    expect(copies.rows.get(uri(1))).toMatchObject({ tombstonedAt: null, status: "active", displayState: "published" });
    expect(copies.rows.get(uri(1))!.payload).not.toBeNull();
  });

  it("re-reading the boundary item of an inclusive updated_since changes nothing", async () => {
    const { sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z")]) }));
    await sync();
    expect(await sync()).toMatchObject({ status: "synced", created: 0, updated: 0, unchanged: 1 });
  });

  it("ignores a tombstone for a listing it never held", async () => {
    const { copies, sync } = await setup(() => ({ status: 200, json: page([tombstone(9, "2026-09-05T09:30:00Z")]) }));
    expect(await sync()).toMatchObject({ unchanged: 1 });
    expect(copies.rows.size).toBe(0);
  });
});

describe("FP-13 a partner that has not approved us yet", () => {
  it("PARTNER_PROVISIONAL is not a failure: no backoff, so polling continues and picks up the approval", async () => {
    const { partners, partner, sync } = await setup(() => ({ status: 403, json: errorEnvelope("PARTNER_PROVISIONAL") }));
    expect(await sync()).toEqual({ status: "awaiting_approval" });
    expect(await sync()).toEqual({ status: "awaiting_approval" });
    expect(partners.get(partner.id)).toMatchObject({ consecutiveFailures: 0, awaitingApproval: true });
    expect(isSyncDue(partners.get(partner.id), NOW)).toBe(true);
  });

  it("clears the awaiting flag on the first successful sync", async () => {
    let approved = false;
    const { partners, partner, sync } = await setup(() =>
      approved ? { status: 200, json: page([]) } : { status: 403, json: errorEnvelope("PARTNER_PROVISIONAL") },
    );
    await sync();
    approved = true;
    await sync();
    expect(partners.get(partner.id).awaitingApproval).toBe(false);
  });

  it("any other 403 — PARTNER_BLOCKED — is a failure and backs off", async () => {
    const { partners, partner, sync } = await setup(() => ({ status: 403, json: errorEnvelope("PARTNER_BLOCKED") }));
    expect(await sync()).toMatchObject({ status: "failed" });
    expect(partners.get(partner.id).consecutiveFailures).toBe(1);
  });

  it("RATE_LIMITED reports Retry-After and is not a failure either", async () => {
    const { partners, partner, sync } = await setup(() => ({ status: 429, json: errorEnvelope("RATE_LIMITED"), headers: { "retry-after": "120" } }));
    expect(await sync()).toEqual({ status: "rate_limited", retryAfterSeconds: 120 });
    expect(partners.get(partner.id).consecutiveFailures).toBe(0);
  });

  it("an unreachable partner is a failure", async () => {
    const { partners, partner, sync } = await setup(() => new Error("connect ECONNREFUSED"));
    expect(await sync()).toEqual({ status: "failed", reason: "connect ECONNREFUSED" });
    expect(partners.get(partner.id).consecutiveFailures).toBe(1);
  });

  it.each<TrustLevel>(["provisional", "blocked"])("never consumes from a partner that is %s on this node", async (trustLevel) => {
    const { authority, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z")]) }), { trustLevel });
    expect(await sync()).toMatchObject({ status: "skipped" });
    expect(authority.requests).toHaveLength(0);
  });
});

describe("LS-5 sanitisation on receipt", () => {
  it("stores descriptions already sanitised, whatever the authority sent", async () => {
    const hostile = [{ section: "overview", content: '<p>Lovely boat.</p><script>alert("x")</script>' }];
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z", { descriptions: hostile })]) }));
    await sync();
    expect(copies.rows.get(uri(1))!.payload!.descriptions).toEqual([{ section: "overview", content: "<p>Lovely boat.</p>" }]);
  });
});

describe("LS-12 registry slugs", () => {
  it("reports unknown builder and category slugs and invents no mapping", async () => {
    const vessel = { ...(listing(1, "x").vessel as object), builder: { name: "Newyard", slug: "newyard" } };
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page([listing(1, "2026-09-01T10:00:00Z", { vessel }), listing(2, "2026-09-01T10:00:00Z")]),
    }));
    await sync();
    expect(copies.rows.get(uri(1))!.unknownSlugs).toEqual(["builder:newyard"]);
    expect((copies.rows.get(uri(1))!.payload!.vessel as { builder: unknown }).builder).toEqual({ name: "Newyard", slug: "newyard" });
    expect(copies.rows.get(uri(2))!.unknownSlugs).toEqual([]);
  });
});

describe("acceptance policy — syncing is not publishing", () => {
  const withheld = {
    listing: { ...(listing(1, "x").listing as object), price: { amount: null, currency: null, on_application: false, starting_price: false } },
  };

  it.each<[AcceptancePolicy, Record<string, unknown>, string]>([
    ["accept_all", {}, "published"],
    ["accept_all", withheld, "published"],
    ["accept_matching", {}, "published"],
    ["accept_matching", withheld, "held"],
    ["accept_matching", { media: { ...(listing(1, "x").media as object), profile: null } }, "held"],
    ["hold", {}, "held"],
  ])("%s with %o → %s", async (policy, overrides, expected) => {
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z", overrides)]) }), { policy });
    await sync();
    // Held or published, the copy is always stored: the sync substrate stays complete.
    expect(copies.rows.get(uri(1))!.displayState).toBe(expected);
  });

  it("ID-10: a listing whose usage.display is false is never displayed, whatever the policy", async () => {
    const usage = { ...(listing(1, "x").usage as object), display: false };
    const { copies, sync } = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z", { usage })]) }), {
      policy: "accept_all",
    });
    await sync();
    expect(copies.rows.get(uri(1))).toMatchObject({ displayState: "held", heldReasons: ["The authority's usage terms do not allow display."] });
  });
});

describe("ID-9 vessel identity conflicts", () => {
  const sameHull = (hin: string) => ({ vessel: { ...(listing(1, "x").vessel as object), hin } });

  it("flags both live listings when two authorities name the same HIN, keeps both, and clears the flag when one ends", async () => {
    const first = await setup(() => ({ status: 200, json: page([listing(1, "2026-09-01T10:00:00Z", sameHull("US-ABC12345D404"))]) }));
    await first.sync();

    // A second partner, sharing the first one's copy store.
    const other = "other-authority.example";
    const pages = [
      [listing(7, "2026-09-02T10:00:00Z", sameHull("us abc12345d404"), other)],
      [{ ...tombstone(7, "2026-09-09T10:00:00Z"), id: uri(7, other) }],
    ];
    const second = new FakeAuthority(other, () => ({ status: 200, json: page(pages.shift()!) }));
    const partner = await first.partners.create({ ...first.partner, domain: other });
    const engine = new SyncEngine({ client: clientFor(second), partners: first.partners, copies: first.copies, sanitiser, registry, clock });

    await engine.syncPartner(first.partners.get(partner.id));
    expect(first.copies.rows.get(uri(1))!.inConflict).toBe(true);
    expect(first.copies.rows.get(uri(7, other))!.inConflict).toBe(true);
    expect(first.copies.rows.size).toBe(2);

    await engine.syncPartner(first.partners.get(partner.id));
    expect(first.copies.rows.get(uri(1))!.inConflict).toBe(false);
  });

  it("does not flag two listings of the same vessel from one authority — a sale and a charter listing, say", async () => {
    const { copies, sync } = await setup(() => ({
      status: 200,
      json: page([listing(1, "2026-09-01T10:00:00Z", sameHull("US-ABC12345D404")), listing(2, "2026-09-01T10:00:00Z", sameHull("US-ABC12345D404"))]),
    }));
    await sync();
    expect([...copies.rows.values()].map((copy) => copy.inConflict)).toEqual([false, false]);
  });
});

describe("FP-15 staleness", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);
  const partner = (lastOkAt: Date | null, createdAt = days(400)) => ({ lastOkAt, createdAt });

  it.each([
    [1, "fresh"],
    [6.9, "fresh"],
    [7, "stale"],
    [29.9, "stale"],
    [30, "hidden"],
  ] as const)("a partner last reached %s days ago is %s", (age, expected) => {
    expect(partnerFreshness(partner(days(age)), NOW)).toBe(expected);
  });

  it("a partner that has never once synced ages from when it was added — it does not stay fresh for ever", () => {
    expect(partnerFreshness(partner(null, days(2)), NOW)).toBe("fresh");
    expect(partnerFreshness(partner(null, days(8)), NOW)).toBe("stale");
    expect(partnerFreshness(partner(null, days(31)), NOW)).toBe("hidden");
  });

  it("backs off exponentially from one hour, capped at 24 hours", () => {
    const hours = (failures: number) => (nextAttemptAt({ consecutiveFailures: failures, lastAttemptAt: NOW })!.getTime() - NOW.getTime()) / 3_600_000;
    expect([1, 2, 3, 4, 5, 6, 12].map(hours)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(nextAttemptAt({ consecutiveFailures: 0, lastAttemptAt: NOW })).toBeNull();
    expect(isSyncDue({ consecutiveFailures: 1, lastAttemptAt: NOW } as Partner, new Date(NOW.getTime() + 59 * 60_000))).toBe(false);
    expect(isSyncDue({ consecutiveFailures: 1, lastAttemptAt: NOW } as Partner, new Date(NOW.getTime() + 60 * 60_000))).toBe(true);
  });
});
