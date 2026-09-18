// Both published signing vectors reproduce byte-for-byte. Spec: protocol/spec/signing-test-vectors.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSigningString, decodePublicKey, deriveKeyId, privateKeyFromSeed, rawPublicKeyOf, sha256Hex, Signer, signString } from "@/federation";
import { RECEIVER, SENDER, TEST_KEY, VECTOR_1, VECTOR_2 } from "./vectors";

const seed = Buffer.from(TEST_KEY.seedHex, "hex");
const utf8 = (text: string) => Buffer.from(text, "utf8");

describe("the transcribed vectors match the vendored spec document", () => {
  const spec = readFileSync(join(process.cwd(), "protocol/spec/signing-test-vectors.md"), "utf8");
  const visible = (signingString: string) => signingString.replaceAll("\n", "\\n");

  it.each([
    ["seed (hex)", TEST_KEY.seedHex],
    ["seed (ASCII)", TEST_KEY.seedAscii],
    ["public key", TEST_KEY.publicKey],
    ["key ID", TEST_KEY.keyId],
    ["vector 1 signing string", visible(VECTOR_1.signingString)],
    ["vector 1 signature", VECTOR_1.signature],
    ["vector 2 body", VECTOR_2.body],
    ["vector 2 body hash", VECTOR_2.bodySha256],
    ["vector 2 signing string", visible(VECTOR_2.signingString)],
    ["vector 2 signature", VECTOR_2.signature],
  ])("%s appears verbatim", (_label, value) => {
    expect(spec).toContain(value);
  });
});

describe("FP-3 key ID derivation", () => {
  it("the hex seed and the ASCII seed are the same 32 bytes", () => {
    expect(seed.equals(utf8(TEST_KEY.seedAscii))).toBe(true);
    expect(seed).toHaveLength(32);
  });

  it("derives the published public key from the seed", () => {
    expect(rawPublicKeyOf(privateKeyFromSeed(seed)).toString("base64")).toBe(TEST_KEY.publicKey);
  });

  it("derives the key ID as the first 16 hex characters of SHA-256 of the raw public key", () => {
    expect(deriveKeyId(decodePublicKey(TEST_KEY.publicKey))).toBe(TEST_KEY.keyId);
  });
});

describe("FP-7 signing string", () => {
  it("vector 1: bodyless GET hashes the empty string", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(VECTOR_1.bodySha256);
    const signingString = buildSigningString({
      method: VECTOR_1.method,
      pathAndQuery: VECTOR_1.pathAndQuery,
      host: RECEIVER,
      timestamp: VECTOR_1.timestamp,
      body: new Uint8Array(0),
    });
    expect(signingString).toBe(VECTOR_1.signingString);
    expect(signingString.split("\n")).toHaveLength(5);
    expect(signingString.endsWith("\n")).toBe(false);
  });

  it("vector 2: POST hashes the raw 94 body bytes", () => {
    expect(utf8(VECTOR_2.body)).toHaveLength(VECTOR_2.bodyLength);
    expect(sha256Hex(utf8(VECTOR_2.body))).toBe(VECTOR_2.bodySha256);
    expect(
      buildSigningString({
        method: VECTOR_2.method,
        pathAndQuery: VECTOR_2.pathAndQuery,
        host: RECEIVER,
        timestamp: VECTOR_2.timestamp,
        body: utf8(VECTOR_2.body),
      }),
    ).toBe(VECTOR_2.signingString);
  });

  it("uppercases the method and lowercases the host", () => {
    expect(
      buildSigningString({
        method: "get",
        pathAndQuery: VECTOR_1.pathAndQuery,
        host: "Receiver.EXAMPLE",
        timestamp: VECTOR_1.timestamp,
        body: new Uint8Array(0),
      }),
    ).toBe(VECTOR_1.signingString);
  });

  it("refuses a field containing a line break", () => {
    expect(() =>
      buildSigningString({
        method: "GET",
        pathAndQuery: "/openyacht/v1/listings\nreceiver.example",
        host: RECEIVER,
        timestamp: VECTOR_1.timestamp,
        body: new Uint8Array(0),
      }),
    ).toThrow();
  });
});

describe("FP-3 / FP-6 signatures reproduce byte-for-byte", () => {
  it("vector 1 signature", () => {
    expect(signString(VECTOR_1.signingString, seed)).toBe(VECTOR_1.signature);
  });

  it("vector 2 signature", () => {
    expect(signString(VECTOR_2.signingString, seed)).toBe(VECTOR_2.signature);
  });

  it("Signer emits all four headers for vector 1", () => {
    const signer = new Signer(SENDER, { keyId: TEST_KEY.keyId, privateSeed: seed }, { now: () => new Date(VECTOR_1.timestamp) });
    expect(signer.sign({ method: "GET", url: new URL(`https://${RECEIVER}${VECTOR_1.pathAndQuery}`) })).toEqual({
      "X-OpenYacht-Node": SENDER,
      "X-OpenYacht-Key": TEST_KEY.keyId,
      "X-OpenYacht-Timestamp": VECTOR_1.timestamp,
      "X-OpenYacht-Signature": VECTOR_1.signature,
    });
  });

  it("Signer emits all four headers for vector 2", () => {
    const signer = new Signer(SENDER, { keyId: TEST_KEY.keyId, privateSeed: seed }, { now: () => new Date(VECTOR_2.timestamp) });
    expect(signer.sign({ method: "POST", url: new URL(`https://${RECEIVER}${VECTOR_2.pathAndQuery}`), body: utf8(VECTOR_2.body) })).toEqual({
      "X-OpenYacht-Node": SENDER,
      "X-OpenYacht-Key": TEST_KEY.keyId,
      "X-OpenYacht-Timestamp": VECTOR_2.timestamp,
      "X-OpenYacht-Signature": VECTOR_2.signature,
    });
  });
});
