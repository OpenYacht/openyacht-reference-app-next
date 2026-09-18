// Inbound request verification (FP-8 … FP-12). Spec: federation-protocol.md
// §Verification procedure. The numbered steps below are the spec's own.
import { verify } from "node:crypto";
import type { ErrorCode } from "./errors";
import { isValidDomain } from "./identity";
import { publicKeyFromRaw } from "./keys";
import {
  systemClock,
  type Clock,
  type PartnerRecord,
  type PartnerStore,
  type PublishedKey,
  type ReplayGuard,
  type VerifierObserver,
  type WellKnownSource,
} from "./ports";
import { HEADER_KEY, HEADER_NODE, HEADER_SIGNATURE, HEADER_TIMESTAMP } from "./signer";
import { buildSigningString } from "./signing-string";

export const TIMESTAMP_WINDOW_SECONDS = 300;

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;
const ED25519_SIGNATURE_LENGTH = 64;

export interface InboundRequest {
  method: string;
  /** Path including the query string, as received. */
  pathAndQuery: string;
  headers: { get(name: string): string | null };
  /** The raw body bytes as received — read before any JSON parsing. */
  body: Uint8Array;
}

export type VerificationResult =
  | { ok: true; partner: PartnerRecord; keyId: string }
  /** `reason` is for the log; the response carries `code` and a generic message. */
  | { ok: false; code: ErrorCode; reason: string };

export interface VerifierOptions {
  /**
   * This node's identity domain. It is the host line of the signing string:
   * federation routes answer on this host only, so the receiver never has to
   * trust a Host header to rebuild what the sender signed.
   */
  ownDomain: string;
  partners: PartnerStore;
  wellKnown: WellKnownSource;
  clock?: Clock;
  replayGuard?: ReplayGuard;
  observer?: VerifierObserver;
}

export class Verifier {
  private readonly clock: Clock;

  constructor(private readonly options: VerifierOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async verify(request: InboundRequest): Promise<VerificationResult> {
    const result = await this.run(request);
    if (!result.ok) {
      const node = request.headers.get(HEADER_NODE);
      await this.options.observer?.rejected?.({ domain: node, code: result.code, reason: result.reason });
    }
    return result;
  }

  private async run(request: InboundRequest): Promise<VerificationResult> {
    const node = request.headers.get(HEADER_NODE)?.trim().toLowerCase() ?? "";
    const keyId = request.headers.get(HEADER_KEY)?.trim() ?? "";
    const timestamp = request.headers.get(HEADER_TIMESTAMP)?.trim() ?? "";
    const signatureText = request.headers.get(HEADER_SIGNATURE)?.trim() ?? "";

    if (node === "" || keyId === "" || timestamp === "" || signatureText === "") {
      return reject("SIGNATURE_INVALID", "One or more X-OpenYacht-* headers are missing.");
    }
    // The sender domain is unauthenticated input that later drives an
    // outbound fetch, so anything that is not a bare hostname stops here.
    if (!isValidDomain(node) || !KEY_ID_PATTERN.test(keyId)) {
      return reject("SIGNATURE_INVALID", "X-OpenYacht-Node or X-OpenYacht-Key is malformed.");
    }
    // A request claiming to come from this node itself is never legitimate,
    // and must not reach the partner lookup.
    if (node === this.options.ownDomain) {
      return reject("SIGNATURE_INVALID", "X-OpenYacht-Node names this node's own domain.");
    }

    // Step 1 — timestamp window (FP-8). Decided before any key is looked at:
    // an out-of-window request is rejected whether or not its signature is good.
    const sentAt = TIMESTAMP_PATTERN.test(timestamp) ? Date.parse(timestamp) : Number.NaN;
    const skewSeconds = Math.abs(this.clock.now().getTime() - sentAt) / 1000;
    if (Number.isNaN(sentAt) || skewSeconds > TIMESTAMP_WINDOW_SECONDS) {
      return reject("TIMESTAMP_OUT_OF_RANGE", "X-OpenYacht-Timestamp is outside ±300 seconds of server time.");
    }
    const tuple = { node, timestamp, signature: signatureText };
    if (await this.options.replayGuard?.isReplay(tuple)) {
      return reject("SIGNATURE_INVALID", "Duplicate (node, timestamp, signature) within the timestamp window.");
    }

    // Step 2 — blocked partners (FP-9).
    const partner = await this.options.partners.findByDomain(node);
    if (partner === null) return reject("PARTNER_UNKNOWN", "No partner record for the sender domain.");
    if (partner.trustLevel === "blocked") return reject("PARTNER_BLOCKED", "The sender is a blocked partner.");

    const signature = Buffer.from(signatureText, "base64");
    if (signature.length !== ED25519_SIGNATURE_LENGTH) {
      return reject("SIGNATURE_INVALID", "X-OpenYacht-Signature is not a base64 Ed25519 signature.");
    }
    const signingString = buildSigningStringOrNull(request, this.options.ownDomain, timestamp);
    if (signingString === null) return reject("SIGNATURE_INVALID", "The request cannot form a signing string.");

    // Steps 3 and 4 — cached keys, selected by key ID.
    let verified = signatureMatches(partner.keys, keyId, signingString, signature);

    // Step 5 — on failure, one fresh well-known fetch and one retry (FP-10).
    // This is what makes key rotation coordination-free.
    if (!verified) {
      let fresh;
      try {
        fresh = await this.options.wellKnown.fetchFresh(node);
      } catch {
        return reject("SIGNATURE_INVALID", "Verification failed and the sender's well-known document could not be refetched.");
      }

      // Step 6 — a changed node UUID means a different installation now
      // answers on this domain. It inherits nothing (FP-11).
      if (fresh.nodeUuid !== partner.nodeUuid) {
        const change = { previousUuid: partner.nodeUuid, newUuid: fresh.nodeUuid };
        await this.options.partners.downgradeToProvisional(node, change);
        await this.options.observer?.nodeUuidChanged?.({ domain: node, ...change });
        return reject("SIGNATURE_INVALID", "The sender's node UUID changed; the partnership needs re-approval.");
      }

      verified = signatureMatches(fresh.keys, keyId, signingString, signature);
      if (!verified) return reject("SIGNATURE_INVALID", "Signature verification failed after key refresh.");
      await this.options.partners.updateCachedKeys(node, fresh.keys);
    }

    // FP-12 — a pinned partner's other keys wait for an administrator, even
    // when the well-known document serves them and the signature is good. The
    // refetch above refreshes the cached keys but never moves the pin.
    if (partner.pinnedKeyId !== null && keyId !== partner.pinnedKeyId) {
      return reject("SIGNATURE_INVALID", "The signing key is not the pinned key; administrator confirmation is required.");
    }

    await this.options.replayGuard?.remember(tuple);
    return { ok: true, partner, keyId };
  }
}

function reject(code: ErrorCode, reason: string): VerificationResult {
  return { ok: false, code, reason };
}

function buildSigningStringOrNull(request: InboundRequest, host: string, timestamp: string): string | null {
  try {
    return buildSigningString({
      method: request.method,
      pathAndQuery: request.pathAndQuery,
      host,
      timestamp,
      body: request.body,
    });
  } catch {
    return null;
  }
}

function signatureMatches(keys: PublishedKey[], keyId: string, signingString: string, signature: Buffer): boolean {
  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (key === undefined) return false;
  return verify(null, Buffer.from(signingString, "utf8"), publicKeyFromRaw(key.publicKey), signature);
}
