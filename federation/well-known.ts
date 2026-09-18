// The discovery document: building our own (FP-1, FP-5) and reading a
// partner's. Spec: federation-protocol.md §Discovery.
import { toWireTimestamp } from "./errors";
import type { OpenYachtDiscoveryDocument } from "./generated";
import { decodePublicKey, deriveKeyId, InvalidKeyError } from "./keys";
import type { NodeIdentity } from "./identity";
import type { DiscoveredNode, PublishedKey } from "./ports";

export const PROTOCOL_VERSION = "1.0";
export const WELL_KNOWN_PATH = "/.well-known/openyacht";
export const API_BASE_PATH = "/openyacht/v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class WellKnownError extends Error {}

/** A key this node publishes. `createdAt` is a wire timestamp. */
export interface OwnPublishedKey {
  keyId: string;
  publicKey: string;
  createdAt: string;
}

export interface WellKnownInput {
  identity: NodeIdentity;
  nodeUuid: string;
  /** e.g. `openyacht-reference-next/0.1.0`. */
  software: string;
  /** Current signing key first, then any key still inside its rotation overlap. */
  keys: OwnPublishedKey[];
  /**
   * The endpoint map lists what this node actually serves. `partners` and
   * `subscriptions` appear only when their routes exist.
   */
  optionalEndpoints?: { partners?: boolean; subscriptions?: boolean };
  now: Date;
}

export function buildWellKnownDocument(input: WellKnownInput): OpenYachtDiscoveryDocument {
  if (!UUID_PATTERN.test(input.nodeUuid)) throw new WellKnownError("The node UUID is missing or malformed.");
  if (input.keys.length === 0) throw new WellKnownError("A node must publish at least one key.");

  const endpoints: OpenYachtDiscoveryDocument["endpoints"] = {
    listings: `${API_BASE_PATH}/listings`,
    health: `${API_BASE_PATH}/health`,
    capabilities: `${API_BASE_PATH}/capabilities`,
  };
  if (input.optionalEndpoints?.partners) endpoints.partners = `${API_BASE_PATH}/partners`;
  if (input.optionalEndpoints?.subscriptions) endpoints.subscriptions = `${API_BASE_PATH}/subscriptions`;

  return {
    openyacht: PROTOCOL_VERSION,
    protocol_versions: [PROTOCOL_VERSION],
    node: {
      uuid: input.nodeUuid,
      name: input.identity.name,
      software: input.software,
      website: input.identity.website,
    },
    keys: input.keys.map((key) => ({
      key_id: key.keyId,
      algorithm: "ed25519",
      public_key: key.publicKey,
      created_at: key.createdAt,
    })),
    endpoints,
    generated_at: toWireTimestamp(input.now),
  };
}

/**
 * Reads the identity and keys out of a partner's well-known document.
 *
 * A published `key_id` is a label chosen by whoever serves the document, so it
 * is never trusted: the key material is strictly decoded and the ID recomputed
 * from it (FP-3). A pin on an unverified label would be a pin on nothing.
 * Entries with another algorithm are skipped rather than rejected, so a future
 * protocol minor can add one; unknown fields are ignored (API-8).
 */
export function parseWellKnownDocument(document: unknown): DiscoveredNode {
  if (!isRecord(document) || !isRecord(document.node)) throw new WellKnownError("Not a discovery document.");
  const { uuid, name } = document.node;
  if (typeof uuid !== "string" || !UUID_PATTERN.test(uuid)) throw new WellKnownError("node.uuid is missing or malformed.");
  if (typeof name !== "string") throw new WellKnownError("node.name is missing.");
  if (!Array.isArray(document.keys)) throw new WellKnownError("keys is missing.");

  const keys: PublishedKey[] = [];
  for (const entry of document.keys) {
    if (!isRecord(entry) || entry.algorithm !== "ed25519") continue;
    if (typeof entry.key_id !== "string" || typeof entry.public_key !== "string") continue;
    let publicKey: Buffer;
    try {
      publicKey = decodePublicKey(entry.public_key);
    } catch (error) {
      if (error instanceof InvalidKeyError) continue;
      throw error;
    }
    if (deriveKeyId(publicKey) !== entry.key_id) continue;
    keys.push({
      keyId: entry.key_id,
      publicKey,
      createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
    });
  }
  if (keys.length === 0) throw new WellKnownError("The document publishes no usable Ed25519 key.");
  return { nodeUuid: uuid, name, keys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
