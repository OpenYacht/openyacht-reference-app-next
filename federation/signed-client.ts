// Signed requests to a partner (FP-6). Every request under /openyacht/v1/
// except `health` and `capabilities` carries the four signature headers.
import type { ErrorCode } from "./errors";
import type { OutboundHttp } from "./ports";
import type { Signer } from "./signer";

export interface FederationResponse {
  status: number;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
  /** `error.code` when the body is an error envelope (API-9). */
  errorCode: ErrorCode | string | null;
  errorMessage: string | null;
  /** Seconds from a Retry-After header, when present and numeric. */
  retryAfterSeconds: number | null;
}

/** Supplies the current signer. A function, so the signing key is read when needed and not held in memory between syncs. */
export type SignerProvider = () => Promise<Signer>;

export class SignedClient {
  constructor(
    private readonly signer: SignerProvider,
    private readonly http: OutboundHttp,
  ) {}

  get(domain: string, pathAndQuery: string): Promise<FederationResponse> {
    return this.send("GET", domain, pathAndQuery);
  }

  post(domain: string, path: string, body: unknown): Promise<FederationResponse> {
    // Serialised once: these exact bytes are both hashed into the signature
    // and sent. Serialising twice is how a body-hash mismatch is born.
    return this.send("POST", domain, path, Buffer.from(JSON.stringify(body), "utf8"));
  }

  /** Unsigned GET, for `capabilities` and `health` (API-6). */
  async getUnsigned(domain: string, path: string): Promise<FederationResponse> {
    return toFederationResponse(await this.http.request({ method: "GET", url: new URL(`https://${domain.toLowerCase()}${path}`) }));
  }

  private async send(method: "GET" | "POST", domain: string, pathAndQuery: string, body?: Uint8Array): Promise<FederationResponse> {
    const url = new URL(`https://${domain.toLowerCase()}${pathAndQuery}`);
    const signer = await this.signer();
    const headers: Record<string, string> = { ...signer.sign({ method, url, body }) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return toFederationResponse(await this.http.request({ method, url, headers, body }));
  }
}

function toFederationResponse(response: { status: number; headers: Record<string, string>; body: Uint8Array }): FederationResponse {
  let json: unknown = null;
  if (response.body.length > 0) {
    try {
      json = JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      json = null;
    }
  }
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  const retryAfter = Number(response.headers["retry-after"]);
  return {
    status: response.status,
    json,
    errorCode: error !== null && typeof error.code === "string" ? error.code : null,
    errorMessage: error !== null && typeof error.message === "string" ? error.message : null,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
