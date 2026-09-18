// Ed25519 key handling (FP-3). Spec: federation-protocol.md §Keys.
//
// Uses node:crypto only. Node's KeyObject API wants DER, while the protocol
// deals in raw 32-byte values, so the two fixed ASN.1 prefixes below wrap and
// unwrap them. They are constants of the Ed25519 PKCS#8 / SPKI encodings
// (RFC 8410), not configuration.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_LENGTH = 32;

/** The schema's pattern for a base64 raw 32-byte key: 43 characters and one `=`. */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export class InvalidKeyError extends Error {}

export interface GeneratedKeypair {
  keyId: string;
  /** Base64 of the raw 32-byte public key — the form published in the well-known document. */
  publicKey: string;
  /** Raw 32-byte private seed. Encrypt at rest; never log (FP-4). */
  privateSeed: Buffer;
}

export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== RAW_KEY_LENGTH) throw new InvalidKeyError("An Ed25519 private seed is exactly 32 bytes.");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== RAW_KEY_LENGTH) throw new InvalidKeyError("An Ed25519 public key is exactly 32 bytes.");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function rawPublicKeyOf(key: KeyObject): Buffer {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return publicKey.export({ format: "der", type: "spki" }).subarray(-RAW_KEY_LENGTH);
}

/** Key ID = first 16 hex characters of SHA-256 of the raw 32-byte public key (FP-3). */
export function deriveKeyId(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== RAW_KEY_LENGTH) throw new InvalidKeyError("An Ed25519 public key is exactly 32 bytes.");
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

/**
 * Strictly decodes a published public key. Node's base64 decoder is lenient
 * (it skips junk and accepts missing padding), so the text is checked against
 * the schema pattern first and must round-trip exactly.
 */
export function decodePublicKey(encoded: string): Buffer {
  if (!PUBLIC_KEY_PATTERN.test(encoded)) throw new InvalidKeyError("Public key is not base64 of 32 raw bytes.");
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== RAW_KEY_LENGTH || raw.toString("base64") !== encoded) {
    throw new InvalidKeyError("Public key is not canonical base64 of 32 raw bytes.");
  }
  return raw;
}

export function generateKeypair(): GeneratedKeypair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateSeed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-RAW_KEY_LENGTH);
  const rawPublicKey = rawPublicKeyOf(privateKey);
  return { keyId: deriveKeyId(rawPublicKey), publicKey: rawPublicKey.toString("base64"), privateSeed: Buffer.from(privateSeed) };
}
