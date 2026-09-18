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

// ---------------------------------------------------------------------------
// When the framework has rewritten the query string
// ---------------------------------------------------------------------------

// Characters a URL may carry literally in its query, but which a form-style
// encoder escapes. `&`, `=`, `+` and `%` are structural and never touched.
const LITERAL_IN_A_QUERY = new Set([..."!$'()*,/:;?@[]^`{|}~"].map((character) => character.charCodeAt(0)));

/**
 * The forms of `path?query` a sender may have signed, given the form the
 * receiver's framework reports.
 *
 * The signing string uses the request target as sent. Many frameworks never
 * show it to the application: they parse the URL and hand back a re-encoded
 * one, in which `updated_since=2026-08-01T00:00:00Z` has become
 * `updated_since=2026-08-01T00%3A00%3A00Z`. A client that sent the literal
 * colons — as the protocol's own first test vector does — signed a string the
 * receiver can no longer see, and every such request would fail verification.
 *
 * So the verifier is given both spellings: the query as reported, and the same
 * query with the escapes a URL does not need undone. This loosens nothing. The
 * two spellings decode to the same parameters — the same request — and a
 * signature still has to match one of them exactly.
 */
export function pathAndQueryVariants(pathAndQuery: string): string[] {
  const question = pathAndQuery.indexOf("?");
  if (question === -1) return [pathAndQuery];
  const path = pathAndQuery.slice(0, question);
  const query = pathAndQuery.slice(question + 1);
  const literal = query.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return LITERAL_IN_A_QUERY.has(code) ? String.fromCharCode(code) : escape;
  });
  return literal === query ? [pathAndQuery] : [pathAndQuery, `${path}?${literal}`];
}
