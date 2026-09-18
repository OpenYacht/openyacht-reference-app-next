// The signing string (FP-7). Spec: federation-protocol.md §Request Signing,
// signing-test-vectors.md §Signing-string construction.
import { createHash } from "node:crypto";

export interface SignedRequestParts {
  method: string;
  /** Request path including the query string, exactly as sent on the wire. */
  pathAndQuery: string;
  /** Host of the receiving node. */
  host: string;
  /** The X-OpenYacht-Timestamp value, verbatim. */
  timestamp: string;
  /** Raw request body bytes; empty for a bodyless request. */
  body: Uint8Array;
}

export class SigningStringError extends Error {}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Five fields joined by single `\n` characters, no trailing newline: uppercase
 * method, path + query, lowercase host, timestamp, lowercase hex SHA-256 of the
 * raw body (the hash of the empty string when there is no body).
 *
 * The body is hashed as received bytes — never re-serialised JSON, which would
 * not reproduce the sender's bytes.
 */
export function buildSigningString(parts: SignedRequestParts): string {
  const fields = [parts.method.toUpperCase(), parts.pathAndQuery, parts.host.toLowerCase(), parts.timestamp, sha256Hex(parts.body)];
  // The newline is the field separator, so a field containing one would let
  // two different requests share a signing string.
  if (fields.some((field) => /[\r\n]/.test(field))) {
    throw new SigningStringError("Signing-string fields must not contain line breaks.");
  }
  return fields.join("\n");
}
