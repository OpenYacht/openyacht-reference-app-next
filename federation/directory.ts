// The node directory and the listing token. Spec: federation-protocol.md
// §Finding partners: the node directory, §The listing token.
//
// The directory is advisory, out-of-band data (FP-16): a phonebook of nodes
// that asked to be listed. Nothing here verifies, trusts or endorses anyone —
// a node found in it is added exactly like any other domain, from its own
// well-known document — and nothing on the wire depends on it.
import { verify } from "node:crypto";
import { isValidDomain } from "./identity";
import { publicKeyFromRaw } from "./keys";
import type { PublishedKey } from "./ports";
import { signString } from "./signer";

export interface DirectoryEntry {
  domain: string;
  name: string;
  website: string | null;
  country: string | null;
  listedAt: string | null;
}

export interface NodeDirectory {
  version: string;
  entries: DirectoryEntry[];
  /** Entries left out because they were malformed. Advisory data is read leniently: one bad entry costs only itself. */
  skipped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optional = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : null);

/** Reads a vendored `nodes.json`. Display metadata only: no keys, no endpoints, nothing trust-bearing. */
export function parseNodeDirectory(document: unknown): NodeDirectory {
  if (!isRecord(document) || document.registry !== "openyacht-nodes" || !Array.isArray(document.nodes)) {
    throw new Error("Not an OpenYacht node directory.");
  }
  const entries: DirectoryEntry[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const node of document.nodes) {
    const domain = isRecord(node) && typeof node.domain === "string" ? node.domain : "";
    const name = isRecord(node) && typeof node.name === "string" ? node.name.trim() : "";
    // The domain is the primary key: lowercase, no scheme, path or port, unique.
    if (!isValidDomain(domain) || name === "" || seen.has(domain)) {
      skipped++;
      continue;
    }
    seen.add(domain);
    entries.push({
      domain,
      name,
      website: optional(node.website, /^https:\/\/\S+$/),
      country: optional(node.country, /^[A-Z]{2}$/),
      listedAt: optional(node.listed_at, /^\d{4}-\d{2}-\d{2}$/),
    });
  }
  return { version: typeof document.version === "string" ? document.version : "unknown", entries, skipped };
}

export type ListingAction = "list" | "delist" | "amend";

const day = (date: Date) => date.toISOString().slice(0, 10);

/** `openyacht-node-listing:v1:{domain}:{action}:{date}` */
export function listingToken(domain: string, action: ListingAction, date: Date): string {
  return `openyacht-node-listing:v1:${domain}:${action}:${day(date)}`;
}

/**
 * The two lines a node operator submits to be listed, delisted or amended.
 * Signed with the same key that signs federation requests: that is what
 * proves the operator controls the domain.
 */
export function signListingRequest(domain: string, action: ListingAction, date: Date, privateSeed: Uint8Array): { token: string; signature: string } {
  const token = listingToken(domain, action, date);
  return { token, signature: signString(token, privateSeed) };
}

const TOKEN_PATTERN = /^openyacht-node-listing:v1:([^:]+):(list|delist|amend):(\d{4}-\d{2}-\d{2})$/;
const WINDOW_DAYS = 30;

/**
 * What a directory maintainer checks. The signature must verify against a key
 * *currently* published in the domain's live well-known document; there is no
 * key-ID line, so each published key is tried. The token is valid within ±30
 * days, so a captured `list` token cannot re-list a node that has delisted.
 */
export function verifyListingRequest(
  request: { token: string; signature: string },
  publishedKeys: PublishedKey[],
  now: Date,
): { ok: true; domain: string; action: ListingAction } | { ok: false; reason: string } {
  const match = TOKEN_PATTERN.exec(request.token);
  if (match === null) return { ok: false, reason: "The token is malformed." };
  const [, domain, action, date] = match as unknown as [string, string, ListingAction, string];
  if (!isValidDomain(domain)) return { ok: false, reason: "The token's domain is not an identity domain." };
  const issued = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(issued) || Math.abs(now.getTime() - issued) > WINDOW_DAYS * 24 * 3600 * 1000) {
    return { ok: false, reason: `The token's date is more than ${WINDOW_DAYS} days away.` };
  }
  const signature = Buffer.from(request.signature, "base64");
  const message = Buffer.from(request.token, "utf8");
  const verified = publishedKeys.some((key) => verify(null, message, publicKeyFromRaw(key.publicKey), signature));
  return verified ? { ok: true, domain, action } : { ok: false, reason: "No key the domain publishes verifies the signature." };
}
