// The three unsigned documents this node serves validate against the
// published schemas — and a half-configured node publishes nothing at all.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { deriveKeyId, decodePublicKey, IdentityConfigError, parseNodeIdentity, parseWellKnownDocument, type OwnPublishedKey } from "@/federation";
import { createFederationHandlers } from "@/lib/federation/handlers";
import type { NodeState } from "@/lib/node/store";
import { TEST_KEY } from "./vectors";

const protocolDir = join(process.cwd(), "protocol");
const SCHEMA_BASE = "https://openyacht.org/schemas/v1/";
const DOMAIN = "node.brokerage.example";
const NOW = new Date("2026-09-18T12:00:00.000Z");

// Same Ajv configuration as the protocol repository's own example validator.
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  for (const file of readdirSync(join(protocolDir, "schemas/v1"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(protocolDir, "schemas/v1", file), "utf8")));
  }
  // Health has no schema file; its shape is the OpenAPI document's `Health` component.
  const openapi = parseYaml(readFileSync(join(protocolDir, "openapi/openyacht-v1.yaml"), "utf8"));
  ajv.addSchema({ $id: "openapi:Health", ...openapi.components.schemas.Health });
});

function expectValid(schemaId: string, document: unknown) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`No schema registered as ${schemaId}`);
  const valid = validate(document);
  expect(validate.errors ?? [], JSON.stringify(document, null, 2)).toEqual([]);
  expect(valid).toBe(true);
}

const publishedKey: OwnPublishedKey = { keyId: TEST_KEY.keyId, publicKey: TEST_KEY.publicKey, createdAt: "2026-09-18T11:00:00Z" };
const readyState: NodeState = { nodeUuid: "018f3c2e-4b6a-7d8e-9f01-23456789abcd", identityDomain: DOMAIN, setupCompleted: true };

function handlers(options: { env?: Record<string, string | undefined>; state?: NodeState; keys?: OwnPublishedKey[] } = {}) {
  const env = options.env ?? {
    OPENYACHT_DOMAIN: DOMAIN,
    OPENYACHT_NODE_NAME: "Example Yacht Brokerage",
    OPENYACHT_WEBSITE: "https://brokerage.example",
  };
  return createFederationHandlers({
    identity: () => parseNodeIdentity(env),
    store: { getState: async () => options.state ?? readyState, listPublishedKeys: async () => options.keys ?? [publishedKey] },
    clock: { now: () => NOW },
    software: "openyacht-reference-next/0.1.0",
    requestId: () => "req_test",
  });
}

const get = (path: string, host = DOMAIN) => new Request(`https://${host}${path}`, { headers: { host } });

afterEach(() => vi.restoreAllMocks());

describe("the vendored schemas are loaded correctly", () => {
  it.each(["well-known", "capabilities", "error"])("the protocol repository's valid %s example validates", (name) => {
    expectValid(`${SCHEMA_BASE}${name}.schema.json`, JSON.parse(readFileSync(join(protocolDir, `examples/valid/${name}.json`), "utf8")));
  });

  // A validator that accepts everything would make every test below pass.
  it.each(readdirSync(join(protocolDir, "examples/invalid")))("the must-fail example %s is rejected", (file) => {
    const validate = ajv.getSchema(`${SCHEMA_BASE}listing.schema.json`)!;
    expect(validate(JSON.parse(readFileSync(join(protocolDir, "examples/invalid", file), "utf8")))).toBe(false);
  });

  it("a discovery document with a malformed key ID or an unknown top-level field is rejected", () => {
    const validate = ajv.getSchema(`${SCHEMA_BASE}well-known.schema.json`)!;
    const example = JSON.parse(readFileSync(join(protocolDir, "examples/valid/well-known.json"), "utf8"));
    expect(validate({ ...example, keys: [{ ...example.keys[0], key_id: "NOT-HEX" }] })).toBe(false);
    expect(validate({ ...example, unexpected: true })).toBe(false);
    expect(validate({ ...example, x_private_extension: true })).toBe(true);
  });
});

describe("FP-1 / FP-5 GET /.well-known/openyacht", () => {
  it("serves a schema-valid discovery document", async () => {
    const response = await handlers().wellKnown(get("/.well-known/openyacht"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const document = await response.json();
    expectValid(`${SCHEMA_BASE}well-known.schema.json`, document);
    expect(document).toMatchObject({
      openyacht: "1.0",
      protocol_versions: ["1.0"],
      node: {
        uuid: readyState.nodeUuid,
        name: "Example Yacht Brokerage",
        software: "openyacht-reference-next/0.1.0",
        website: "https://brokerage.example",
      },
      generated_at: "2026-09-18T12:00:00Z",
    });
  });

  it("FP-3: every published key ID is derivable from its key material", async () => {
    const document = await (await handlers().wellKnown(get("/.well-known/openyacht"))).json();
    for (const key of document.keys) expect(deriveKeyId(decodePublicKey(key.public_key))).toBe(key.key_id);
    // …which is exactly what a partner's strict parser demands of us.
    expect(parseWellKnownDocument(document).keys.map((key) => key.keyId)).toEqual([TEST_KEY.keyId]);
  });

  it("lists only endpoints this node serves — no partners or subscriptions entry yet", async () => {
    const document = await (await handlers().wellKnown(get("/.well-known/openyacht"))).json();
    expect(Object.keys(document.endpoints).sort()).toEqual(["capabilities", "health", "listings"]);
  });

  it("a node with no website publishes null, never an empty string", async () => {
    for (const website of [undefined, "", "   "]) {
      const env = { OPENYACHT_DOMAIN: DOMAIN, OPENYACHT_NODE_NAME: "Example Yacht Brokerage", OPENYACHT_WEBSITE: website };
      const document = await (await handlers({ env }).wellKnown(get("/.well-known/openyacht"))).json();
      expect(document.node.website).toBeNull();
      expectValid(`${SCHEMA_BASE}well-known.schema.json`, document);
    }
  });
});

describe("API-6 unsigned endpoints", () => {
  it("GET /openyacht/v1/capabilities is schema-valid and advertises only what works", async () => {
    const response = await handlers().capabilities(get("/openyacht/v1/capabilities"));
    expect(response.status).toBe(200);
    const document = await response.json();
    expectValid(`${SCHEMA_BASE}capabilities.schema.json`, document);
    expect(document.features).toEqual({ subscriptions: false, charter_listings: true, media_hashes: false });
  });

  it("GET /openyacht/v1/health matches the OpenAPI Health component", async () => {
    const response = await handlers().health(get("/openyacht/v1/health"));
    expect(response.status).toBe(200);
    const document = await response.json();
    expectValid("openapi:Health", document);
    expect(document).toEqual({ status: "ok", time: "2026-09-18T12:00:00Z" });
  });
});

describe("API-9 unknown federation paths", () => {
  it("answer NOT_FOUND in a schema-valid error envelope", async () => {
    const response = await handlers().notFound(get("/openyacht/v1/nothing-here"));
    expect(response.status).toBe(404);
    const document = await response.json();
    expectValid(`${SCHEMA_BASE}error.schema.json`, document);
    expect(document.error.code).toBe("NOT_FOUND");
  });
});

/** Every route the node serves, so that the gate in front of them is checked for each — new ones included. */
function everyRoute(served: ReturnType<typeof handlers>): ((request: Request) => Promise<Response>)[] {
  return [
    served.wellKnown,
    served.capabilities,
    served.health,
    served.partnersRequest,
    served.listings,
    (request) => served.listing(request, "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b"),
    (request) => served.methodNotAllowed(request, ["GET"]),
    served.notFound,
  ];
}

describe("single-host guard", () => {
  it.each(["localhost:3000", "admin.brokerage.example", "brokerage.example"])("answers a bare 404 on %s", async (host) => {
    for (const route of everyRoute(handlers())) {
      const response = await route(get("/.well-known/openyacht", host));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("accepts the identity domain with a port and in any case", async () => {
    expect((await handlers().health(get("/openyacht/v1/health", `${DOMAIN.toUpperCase()}:443`))).status).toBe(200);
  });
});

describe("a node that is not ready publishes nothing", () => {
  it("answers 503 on every federation route until setup completes", async () => {
    const state: NodeState = { nodeUuid: null, identityDomain: null, setupCompleted: false };
    for (const route of everyRoute(handlers({ state }))) {
      expect((await route(get("/.well-known/openyacht"))).status).toBe(503);
    }
  });

  it("answers 503 and logs when the node state cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = createFederationHandlers({
      identity: () => parseNodeIdentity({ OPENYACHT_DOMAIN: DOMAIN, OPENYACHT_NODE_NAME: "Example" }),
      store: { getState: () => Promise.reject(new Error("connection refused")), listPublishedKeys: async () => [] },
      clock: { now: () => NOW },
      software: "test",
      requestId: () => "req_test",
    });
    expect((await broken.wellKnown(get("/.well-known/openyacht"))).status).toBe(503);
    expect(logged).toHaveBeenCalledOnce();
  });

  it.each([
    ["OPENYACHT_NODE_NAME blank", { OPENYACHT_DOMAIN: DOMAIN, OPENYACHT_NODE_NAME: "" }],
    ["OPENYACHT_NODE_NAME whitespace", { OPENYACHT_DOMAIN: DOMAIN, OPENYACHT_NODE_NAME: "   " }],
    ["OPENYACHT_NODE_NAME missing", { OPENYACHT_DOMAIN: DOMAIN }],
    ["OPENYACHT_DOMAIN blank", { OPENYACHT_DOMAIN: "", OPENYACHT_NODE_NAME: "Example" }],
  ])("fails loudly with %s — a 500 and a log line, never a document", async (_label, env) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handlers({ env }).wellKnown(get("/.well-known/openyacht"));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).not.toContain("json");
    expect(logged).toHaveBeenCalledOnce();
  });

  it("disables federation when OPENYACHT_DOMAIN no longer matches the domain recorded at setup", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handlers({ state: { ...readyState, identityDomain: "old.brokerage.example" } }).wellKnown(get("/.well-known/openyacht"));
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("identity configuration", () => {
  it("reports every problem at once", () => {
    try {
      parseNodeIdentity({ OPENYACHT_DOMAIN: "https://node.example/", OPENYACHT_NODE_NAME: "", OPENYACHT_WEBSITE: "http://plain.example" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityConfigError);
      expect((error as IdentityConfigError).problems).toHaveLength(3);
    }
  });

  it.each(["node.example:8443", "node.example/path", "user@node.example", "192.168.1.10", "localhost", "node_.example"])(
    "rejects %s as an identity domain",
    (domain) => {
      expect(() => parseNodeIdentity({ OPENYACHT_DOMAIN: domain, OPENYACHT_NODE_NAME: "Example" })).toThrow(IdentityConfigError);
    },
  );

  it("normalises the domain to lowercase", () => {
    expect(parseNodeIdentity({ OPENYACHT_DOMAIN: "OpenYacht.Brokerage.Example", OPENYACHT_NODE_NAME: "Example" }).domain).toBe(
      "openyacht.brokerage.example",
    );
  });
});
