// Outbound request signing (FP-6, FP-7). Spec: federation-protocol.md §Request Signing.
import { sign } from "node:crypto";
import { toWireTimestamp } from "./errors";
import { privateKeyFromSeed } from "./keys";
import { systemClock, type Clock } from "./ports";
import { buildSigningString } from "./signing-string";

export const HEADER_NODE = "X-OpenYacht-Node";
export const HEADER_KEY = "X-OpenYacht-Key";
export const HEADER_TIMESTAMP = "X-OpenYacht-Timestamp";
export const HEADER_SIGNATURE = "X-OpenYacht-Signature";

export interface SigningKey {
  keyId: string;
  /** Raw 32-byte private seed. */
  privateSeed: Uint8Array;
}

export interface RequestToSign {
  method: string;
  /** The full URL the request will be sent to; host and path + query are taken from it. */
  url: URL;
  /** The exact bytes that will be sent as the body. Omit for a bodyless request. */
  body?: Uint8Array;
}

export type SignatureHeaders = Record<typeof HEADER_NODE | typeof HEADER_KEY | typeof HEADER_TIMESTAMP | typeof HEADER_SIGNATURE, string>;

/** Ed25519 over the UTF-8 bytes of the signing string, base64-encoded. */
export function signString(signingString: string, privateSeed: Uint8Array): string {
  return sign(null, Buffer.from(signingString, "utf8"), privateKeyFromSeed(privateSeed)).toString("base64");
}

export class Signer {
  constructor(
    /** This node's identity domain, sent as X-OpenYacht-Node. */
    private readonly nodeDomain: string,
    private readonly key: SigningKey,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Returns the four X-OpenYacht-* headers for the request. The body passed here must be the body sent. */
  sign(request: RequestToSign): SignatureHeaders {
    const timestamp = toWireTimestamp(this.clock.now());
    const signingString = buildSigningString({
      method: request.method,
      pathAndQuery: request.url.pathname + request.url.search,
      host: request.url.hostname,
      timestamp,
      body: request.body ?? new Uint8Array(0),
    });
    return {
      [HEADER_NODE]: this.nodeDomain,
      [HEADER_KEY]: this.key.keyId,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_SIGNATURE]: signString(signingString, this.key.privateSeed),
    };
  }
}
