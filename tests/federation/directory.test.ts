// The node directory and the listing token. Spec: federation-protocol.md
// §Finding partners: the node directory (FP-16), §The listing token.
import { describe, expect, it } from "vitest";
import { generateKeypair, listingToken, parseNodeDirectory, signListingRequest, verifyListingRequest, type PublishedKey } from "@/federation";
import vendored from "@/protocol/registry/nodes.json";

const NOW = new Date("2026-09-27T12:00:00Z");
const published = (keypair: ReturnType<typeof generateKeypair>): PublishedKey => ({
  keyId: keypair.keyId,
  publicKey: Buffer.from(keypair.publicKey, "base64"),
  createdAt: "2026-09-01T00:00:00Z",
});

describe("FP-16 the node directory", () => {
  it("reads the vendored copy", () => {
    expect(parseNodeDirectory(vendored)).toMatchObject({ version: vendored.version, skipped: 0 });
  });

  it("keeps display metadata only, and skips malformed or duplicate entries without failing the rest", () => {
    const directory = parseNodeDirectory({
      registry: "openyacht-nodes",
      version: "2026.10.0",
      nodes: [
        {
          domain: "openyacht.harbour-brokers.example",
          name: "Harbour Brokers",
          website: "https://harbour-brokers.example",
          country: "GB",
          listed_at: "2026-10-01",
        },
        { domain: "https://bad.example", name: "Scheme in the domain" },
        { domain: "openyacht.harbour-brokers.example", name: "Duplicate" },
        { domain: "quiet.example", name: "Quiet Yachts", website: "http://not-https.example", country: "gb" },
      ],
    });
    expect(directory.skipped).toBe(2);
    expect(directory.entries).toEqual([
      {
        domain: "openyacht.harbour-brokers.example",
        name: "Harbour Brokers",
        website: "https://harbour-brokers.example",
        country: "GB",
        listedAt: "2026-10-01",
      },
      { domain: "quiet.example", name: "Quiet Yachts", website: null, country: null, listedAt: null },
    ]);
  });

  it("refuses a document that is not a node directory", () => {
    expect(() => parseNodeDirectory({ registry: "openyacht-builders", nodes: [] })).toThrow(/Not an OpenYacht node directory/);
  });
});

describe("the listing token", () => {
  const keypair = generateKeypair();
  const request = signListingRequest("node.example", "list", NOW, keypair.privateSeed);

  it("has the exact form the directory expects", () => {
    expect(listingToken("node.example", "delist", NOW)).toBe("openyacht-node-listing:v1:node.example:delist:2026-09-27");
    expect(request.token).toBe("openyacht-node-listing:v1:node.example:list:2026-09-27");
  });

  it("verifies against any currently published key, with no key ID to copy", () => {
    const other = published(generateKeypair());
    expect(verifyListingRequest(request, [other, published(keypair)], NOW)).toEqual({ ok: true, domain: "node.example", action: "list" });
  });

  it("is refused outside ±30 days, under another key, or when altered", () => {
    expect(verifyListingRequest(request, [published(keypair)], new Date("2026-10-28T12:00:00Z"))).toMatchObject({ ok: false });
    expect(verifyListingRequest(request, [published(generateKeypair())], NOW)).toMatchObject({ ok: false });
    const altered = { ...request, token: request.token.replace(":list:", ":delist:") };
    expect(verifyListingRequest(altered, [published(keypair)], NOW)).toMatchObject({ ok: false });
  });
});
