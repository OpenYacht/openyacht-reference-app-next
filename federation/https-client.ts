// The one HTTP client the federation core uses for partner hosts. node:https
// only — no third-party client.
//
// Three properties matter, and each closes a specific hole:
//   * The outbound guard runs inside the socket's DNS lookup, so the address
//     that was checked is the address that is connected to. Checking a name
//     first and connecting afterwards leaves a gap in which DNS can change.
//   * Redirects are never followed: a 302 to http:// or to an internal host
//     would undo both the TLS requirement (FP-2) and the guard.
//   * Certificates are always verified (FP-2). Nothing here can switch that off.
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { BlockedOutboundHost, parsePublicHttpsUrl, resolvePublicHost, systemResolver, type Resolver } from "./outbound-guard";
import type { OutboundHttp, OutboundRequest, OutboundResponse } from "./ports";

export class OutboundRequestError extends Error {}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class GuardedHttpsClient implements OutboundHttp {
  constructor(
    private readonly userAgent: string,
    private readonly resolver: Resolver = systemResolver,
  ) {}

  async request(options: OutboundRequest): Promise<OutboundResponse> {
    const url = parsePublicHttpsUrl(options.url.toString());
    const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;

    // Called by the socket when it connects. Whatever it returns is what gets
    // dialled, so a refused address never becomes a connection.
    const guardedLookup: LookupFunction = (hostname, _options, callback) => {
      resolvePublicHost(hostname, this.resolver).then(
        (addresses) => callback(null, addresses),
        (error: Error) => callback(error, []),
      );
    };

    return new Promise<OutboundResponse>((resolve, reject) => {
      const outgoing = httpsRequest(
        url,
        {
          method: options.method,
          headers: { "user-agent": this.userAgent, accept: "application/json", ...options.headers },
          lookup: guardedLookup,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
              outgoing.destroy(new OutboundRequestError(`Response from ${url.hostname} exceeds ${maxBytes} bytes.`));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
            }
            resolve({ status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          incoming.on("error", reject);
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new OutboundRequestError(`Request to ${url.hostname} timed out.`)));
      outgoing.on("error", (error) =>
        reject(error instanceof BlockedOutboundHost || error instanceof OutboundRequestError ? error : new OutboundRequestError(error.message)),
      );
      outgoing.end(options.body);
    });
  }
}
