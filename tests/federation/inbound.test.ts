// Signed inbound requests through the real handler: a real Signer on one side,
// the real Verifier on the other, in-memory storage between them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodePublicKey, generateKeypair, Signer, Verifier, type DiscoveredNode, type PartnerRecord, type TrustLevel } from "@/federation";
import { createFederationHandlers, type InboundFederation } from "@/lib/federation/handlers";

const DOMAIN = "node.brokerage.example";
const SENDER = "partner.example";
const NOW = new Date("2026-09-18T12:00:00Z");
const clock = { now: () => NOW };
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";
const PATH = "/openyacht/v1/partners/request";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  const dir = join(process.cwd(), "protocol/schemas/v1");
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")));
});
const validError = (document: unknown) => ajv.getSchema("https://openyacht.org/schemas/v1/error.schema.json")!(document);

afterEach(() => vi.restoreAllMocks());

const senderKeys = generateKeypair();
const discovered: DiscoveredNode = {
  nodeUuid: NODE_UUID,
  name: "Partner Yachts",
  keys: [{ keyId: senderKeys.keyId, publicKey: decodePublicKey(senderKeys.publicKey), createdAt: "2026-09-01T00:00:00Z" }],
};

function setup(options: { known?: TrustLevel } = {}) {
  const partners = new Map<string, PartnerRecord>();
  if (options.known)
    partners.set(SENDER, { domain: SENDER, nodeUuid: NODE_UUID, trustLevel: options.known, keys: discovered.keys, pinnedKeyId: null });
  const requests: { domain: string; message: string | null; contactEmail: string | null }[] = [];
  const log: { outcome: string; status: number; senderDomain: string | null; partnerDomain: string | null; path: string }[] = [];

  const inbound: InboundFederation = {
    verify: (request) =>
      new Verifier({
        ownDomain: DOMAIN,
        clock,
        partners: {
          findByDomain: async (domain) => partners.get(domain) ?? null,
          updateCachedKeys: async () => {},
          downgradeToProvisional: async () => {},
          registerFirstContact: async (domain, node) => {
            const partner: PartnerRecord = { domain, nodeUuid: node.nodeUuid, trustLevel: "provisional", keys: node.keys, pinnedKeyId: null };
            partners.set(domain, partner);
            return partner;
          },
        },
        wellKnown: { fetchFresh: async () => discovered },
      }).verify(request),
    recordPartnerRequest: async (domain, request) => void requests.push({ domain, ...request }),
    log: async (entry) => void log.push(entry),
  };

  const handlers = createFederationHandlers({
    identity: () => ({ domain: DOMAIN, name: "Example Yacht Brokerage", website: null }),
    store: {
      getState: async () => ({ nodeUuid: NODE_UUID, identityDomain: DOMAIN, setupCompleted: true }),
      listPublishedKeys: async () => [{ keyId: senderKeys.keyId, publicKey: senderKeys.publicKey, createdAt: "2026-09-01T00:00:00Z" }],
    },
    clock,
    software: "test",
    requestId: () => "req_test",
    inbound,
  });
  return { handlers, partners, requests, log };
}

/** A request signed exactly as a partner node would sign it. */
function signedPost(body: string, options: { tamper?: (body: string) => string; host?: string } = {}) {
  const bytes = Buffer.from(body, "utf8");
  const url = new URL(`https://${DOMAIN}${PATH}`);
  const headers = new Signer(SENDER, senderKeys, clock).sign({ method: "POST", url, body: bytes });
  return new Request(url, {
    method: "POST",
    headers: { ...headers, host: options.host ?? DOMAIN, "content-type": "application/json" },
    body: options.tamper ? options.tamper(body) : body,
  });
}

const BODY = '{"message":"Requesting partnership for co-brokerage.","contact_email":"broker@partner.example"}';

describe("FP-13 POST /openyacht/v1/partners/request", () => {
  it("first contact: registers the sender as provisional, stores the request, and answers 202 pending", async () => {
    const { handlers, partners, requests, log } = setup();
    const response = await handlers.partnersRequest(signedPost(BODY));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", trust_level: "provisional" });
    expect(partners.get(SENDER)?.trustLevel).toBe("provisional");
    expect(requests).toEqual([{ domain: SENDER, message: "Requesting partnership for co-brokerage.", contactEmail: "broker@partner.example" }]);
    expect(log).toEqual([
      { requestId: "req_test", senderDomain: SENDER, partnerDomain: SENDER, method: "POST", path: PATH, outcome: "ok", status: 202 },
    ]);
  });

  it("an already approved partner is told so", async () => {
    const { handlers } = setup({ known: "verified" });
    expect(await (await handlers.partnersRequest(signedPost(BODY))).json()).toEqual({ status: "accepted", trust_level: "verified" });
  });

  it("is lenient about the body: a sender that omits both fields has still introduced itself", async () => {
    const { handlers, requests } = setup();
    expect((await handlers.partnersRequest(signedPost("{}"))).status).toBe(202);
    expect(requests).toEqual([{ domain: SENDER, message: null, contactEmail: null }]);
  });

  it("truncates an over-long message rather than storing it whole", async () => {
    const { handlers, requests } = setup();
    await handlers.partnersRequest(signedPost(JSON.stringify({ message: "x".repeat(5000), contact_email: "a@b.example" })));
    expect(requests[0]!.message).toHaveLength(2000);
  });

  it("FP-7: a body altered after signing is rejected with a schema-valid SIGNATURE_INVALID envelope, and nothing is registered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers, partners, requests, log } = setup();
    const response = await handlers.partnersRequest(signedPost(BODY, { tamper: (body) => body.replace('{"message":', '{"message": ') }));
    expect(response.status).toBe(401);
    const envelope = await response.json();
    expect(validError(envelope)).toBe(true);
    expect(envelope.error).toMatchObject({ code: "SIGNATURE_INVALID", details: { well_known: "/.well-known/openyacht" } });
    expect(partners.size).toBe(0);
    expect(requests).toEqual([]);
    expect(log).toMatchObject([{ outcome: "SIGNATURE_INVALID", status: 401, partnerDomain: null }]);
  });

  it("does not tell a rejected sender why verification failed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = setup();
    const envelope = await (await handlers.partnersRequest(signedPost(BODY, { tamper: (body) => body + " " }))).json();
    expect(envelope.error.message).toBe("Signature verification failed after key refresh.");
    // The precise reason goes to the log instead.
    expect(warned.mock.calls[0]![0]).toContain("does not verify");
  });

  it("FP-9: a blocked partner gets PARTNER_BLOCKED", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers, requests } = setup({ known: "blocked" });
    const response = await handlers.partnersRequest(signedPost(BODY));
    expect(response.status).toBe(403);
    const envelope = await response.json();
    expect(validError(envelope)).toBe(true);
    expect(envelope.error.code).toBe("PARTNER_BLOCKED");
    expect(requests).toEqual([]);
  });

  it("rejects a body that is not JSON with VALIDATION_ERROR", async () => {
    const { handlers } = setup({ known: "verified" });
    const response = await handlers.partnersRequest(signedPost("not json"));
    expect(response.status).toBe(422);
    expect(validError(await response.json())).toBe(true);
  });

  it("answers a bare 404 on any host but the identity domain, before reading a signature", async () => {
    const { handlers, log } = setup();
    const response = await handlers.partnersRequest(signedPost(BODY, { host: "localhost:3000" }));
    expect(response.status).toBe(404);
    expect(log).toEqual([]);
  });
});

describe("wrong method on a known path", () => {
  it("answers 405 with an Allow header and no body", async () => {
    const { handlers } = setup();
    const response = await handlers.methodNotAllowed(new Request(`https://${DOMAIN}${PATH}`, { headers: { host: DOMAIN } }), ["POST"]);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe("");
  });
});

describe("FP-1 the endpoint map", () => {
  it("lists `partners` once the partnership-request route is served", async () => {
    const { handlers } = setup();
    const document = await (await handlers.wellKnown(new Request(`https://${DOMAIN}/.well-known/openyacht`, { headers: { host: DOMAIN } }))).json();
    expect(document.endpoints.partners).toBe("/openyacht/v1/partners");
    expect(ajv.getSchema("https://openyacht.org/schemas/v1/well-known.schema.json")!(document)).toBe(true);
  });
});
