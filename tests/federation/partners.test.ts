// Partner operations: adding, key refresh and pin confirmation, the signed
// partnership request, and removal.
import { describe, expect, it } from "vitest";
import { PartnerError, PartnerService, type AcceptancePolicy } from "@/federation";
import {
  AUTHORITY,
  clientFor,
  clock,
  discovery,
  errorEnvelope,
  FakeAuthority,
  MemoryPartners,
  OWN_DOMAIN,
  page,
  publishedKey,
} from "./support/consumer-harness";

const addOptions = { pinKey: true, acceptancePolicy: "accept_all" as AcceptancePolicy };
const request = { message: "Requesting partnership for co-brokerage.", contactEmail: "broker@consumer.example" };

function service(
  route: ConstructorParameters<typeof FakeAuthority>[1] = () => ({ status: 202, json: { status: "pending", trust_level: "provisional" } }),
) {
  const keys = [publishedKey(), publishedKey()];
  const partners = new MemoryPartners();
  const wellKnown = discovery({ keys });
  const authority = new FakeAuthority(AUTHORITY, route);
  const partnerService = new PartnerService({ ownDomain: OWN_DOMAIN, partners, wellKnown, client: clientFor(authority), clock });
  return { partnerService, partners, wellKnown, authority, keys };
}

describe("FP-13 adding a partner", () => {
  it("stores the discovered UUID, name and keys, approved by the administrator who added it", async () => {
    const { partnerService, keys } = service();
    const partner = await partnerService.add(` ${AUTHORITY.toUpperCase()} `, addOptions);
    expect(partner).toMatchObject({ domain: AUTHORITY, nodeName: "Authority Yachts", trustLevel: "verified", keys, acceptancePolicy: "accept_all" });
  });

  it("FP-12: arms the pin to the partner's current signing key — the first one listed — when asked to", async () => {
    const { partnerService, keys } = service();
    expect((await partnerService.add(AUTHORITY, addOptions)).pinnedKeyId).toBe(keys[0]!.keyId);
  });

  it("FP-12: leaves the partner unpinned otherwise, keeping key rotation coordination-free", async () => {
    const { partnerService } = service();
    expect((await partnerService.add(AUTHORITY, { ...addOptions, pinKey: false })).pinnedKeyId).toBeNull();
  });

  it("refuses the node's own domain before fetching anything", async () => {
    const { partnerService, wellKnown } = service();
    await expect(partnerService.add(OWN_DOMAIN, addOptions)).rejects.toThrow(/own domain/);
    expect(wellKnown.calls).toBe(0);
  });

  it.each(["169.254.169.254", "partner.example:8443", "https://partner.example", "localhost"])(
    "refuses %s before fetching anything",
    async (domain) => {
      const { partnerService, wellKnown } = service();
      await expect(partnerService.add(domain, addOptions)).rejects.toBeInstanceOf(PartnerError);
      expect(wellKnown.calls).toBe(0);
    },
  );

  it("refuses a domain that is already a partner", async () => {
    const { partnerService } = service();
    await partnerService.add(AUTHORITY, addOptions);
    await expect(partnerService.add(AUTHORITY, addOptions)).rejects.toThrow(/already a partner/);
  });
});

describe("FP-12 pin confirmation", () => {
  async function pinnedPartnerThatRotates() {
    const context = service();
    const partner = await context.partnerService.add(AUTHORITY, addOptions);
    const rotated = publishedKey();
    // Routine rotation: the new key is published first, alongside the old one.
    context.wellKnown.fetchFresh = async () => ({ nodeUuid: partner.nodeUuid, name: "Authority Yachts", keys: [rotated, ...context.keys] });
    return { ...context, partner, rotated };
  }

  it("the administrator's explicit refresh moves the pin to the rotated key", async () => {
    const { partnerService, partners, partner, rotated } = await pinnedPartnerThatRotates();
    expect(await partnerService.refreshKeys(partner, { confirmPin: true })).toBe("repinned");
    expect(partners.get(partner.id).pinnedKeyId).toBe(rotated.keyId);
    expect(partners.get(partner.id).keys[0]!.keyId).toBe(rotated.keyId);
  });

  it("a refresh without confirmation updates the cached keys and never moves the pin", async () => {
    const { partnerService, partners, partner, rotated, keys } = await pinnedPartnerThatRotates();
    expect(await partnerService.refreshKeys(partner, { confirmPin: false })).toBe("refreshed");
    expect(partners.get(partner.id).pinnedKeyId).toBe(keys[0]!.keyId);
    expect(partners.get(partner.id).keys[0]!.keyId).toBe(rotated.keyId);
  });

  it("FP-11: a changed node UUID downgrades the partner and leaves both keys and pin alone, even with confirmation", async () => {
    const { partnerService, partners, partner, wellKnown, keys } = await pinnedPartnerThatRotates();
    wellKnown.fetchFresh = async () => ({ nodeUuid: "018f3c2e-4b6a-7d8e-9f01-ffffffffffff", name: "Someone Else", keys: [publishedKey()] });
    expect(await partnerService.refreshKeys(partner, { confirmPin: true })).toBe("uuid_changed");
    expect(partners.get(partner.id)).toMatchObject({ trustLevel: "provisional", pinnedKeyId: keys[0]!.keyId, keys, nodeName: "Authority Yachts" });
  });
});

describe("FP-13 the partnership request", () => {
  it("is a signed POST carrying both body fields", async () => {
    const { partnerService, authority } = service();
    const partner = await partnerService.add(AUTHORITY, addOptions);
    await partnerService.introduce(partner, request);
    expect(authority.signed).toHaveLength(1);
    expect(authority.signed[0]).toMatchObject({
      method: "POST",
      host: AUTHORITY,
      path: "/openyacht/v1/partners/request",
      verified: true,
      body: { message: request.message, contact_email: request.contactEmail },
    });
  });

  it.each([
    ["delivered", { status: 202, json: { status: "pending", trust_level: "provisional" } }],
    ["accepted", { status: 202, json: { status: "ok", trust_level: "verified" } }],
    ["delivered", { status: 403, json: errorEnvelope("PARTNER_PROVISIONAL") }],
    ["blocked", { status: 403, json: errorEnvelope("PARTNER_BLOCKED") }],
    ["failed", { status: 500 }],
  ] as const)("reports %s for %o", async (expected, answer) => {
    const { partnerService, partners } = service(() => answer);
    const partner = await partnerService.add(AUTHORITY, addOptions);
    expect((await partnerService.introduce(partner, request)).result).toBe(expected);
    // Stamped only when the introduction actually reached the partner.
    expect(partners.get(partner.id).requestSentAt !== null).toBe(expected === "delivered" || expected === "accepted");
  });

  it("falls back to a signed listings probe when the partner has no request endpoint", async () => {
    const { partnerService, authority } = service((incoming) =>
      incoming.path.endsWith("/partners/request") ? { status: 404 } : { status: 200, json: page([]) },
    );
    const partner = await partnerService.add(AUTHORITY, addOptions);
    // Listings are served to verified partners only, so a page means "already approved".
    expect(await partnerService.introduce(partner, request)).toEqual({ result: "accepted" });
    expect(authority.signed.map((incoming) => `${incoming.method} ${incoming.path}`)).toEqual([
      "POST /openyacht/v1/partners/request",
      "GET /openyacht/v1/listings",
    ]);
    expect(authority.signed[1]!.query.get("page_size")).toBe("1");
  });

  it("reads PARTNER_PROVISIONAL on the probe as delivered", async () => {
    const { partnerService } = service((incoming) =>
      incoming.path.endsWith("/partners/request") ? { status: 405 } : { status: 403, json: errorEnvelope("PARTNER_PROVISIONAL") },
    );
    const partner = await partnerService.add(AUTHORITY, addOptions);
    expect(await partnerService.introduce(partner, request)).toEqual({ result: "delivered" });
  });

  it("reports an unreachable partner as failed and keeps the partner", async () => {
    const { partnerService, partners } = service(() => new Error("connect ETIMEDOUT"));
    const partner = await partnerService.add(AUTHORITY, addOptions);
    expect(await partnerService.introduce(partner, request)).toEqual({ result: "failed", reason: "connect ETIMEDOUT" });
    expect(partners.get(partner.id).requestSentAt).toBeNull();
  });
});

describe("removing a partner", () => {
  it("is allowed while nothing has been received from it", async () => {
    const { partnerService, partners } = service();
    const partner = await partnerService.add(AUTHORITY, addOptions);
    await partnerService.remove(partner);
    expect(await partners.findByDomain(AUTHORITY)).toBeNull();
  });

  it("ID-3: is refused once copies exist — the partner record anchors their provenance", async () => {
    const { partnerService, partners } = service();
    const partner = await partnerService.add(AUTHORITY, addOptions);
    partners.copyCounts.set(partner.id, 3);
    await expect(partnerService.remove(partner)).rejects.toThrow(/Block it instead/);
    expect(await partners.findByDomain(AUTHORITY)).not.toBeNull();
  });
});
