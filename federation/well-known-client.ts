// Fetching a partner's discovery document (FP-2, FP-10). Spec:
// federation-protocol.md §Discovery, §Verification procedure step 5.
import { WELL_KNOWN_PATH, parseWellKnownDocument, WellKnownError } from "./well-known";
import { systemClock, type Clock, type DiscoveredNode, type OutboundHttp, type WellKnownSource } from "./ports";

export class RefetchRateLimited extends Error {}

/** The spec's suggested limit on the public well-known endpoint: one request a minute per consumer. */
const MIN_REFETCH_INTERVAL_MS = 60_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;

export class WellKnownClient implements WellKnownSource {
  private readonly lastFetch = new Map<string, number>();

  constructor(
    private readonly http: OutboundHttp,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * A fresh fetch, bypassing any cache — but never more than once a minute per
   * domain. That bound matters on the verification path: a stream of bad
   * signatures naming one domain must not become a stream of requests to it.
   */
  async fetchFresh(domain: string): Promise<DiscoveredNode> {
    const host = domain.toLowerCase();
    const now = this.clock.now().getTime();
    const last = this.lastFetch.get(host);
    if (last !== undefined && now - last < MIN_REFETCH_INTERVAL_MS) {
      throw new RefetchRateLimited(`The discovery document of ${host} was fetched less than a minute ago.`);
    }
    this.lastFetch.set(host, now);

    // https:// and the identity domain, always: TLS is the trust anchor (FP-2).
    const response = await this.http.request({
      method: "GET",
      url: new URL(`https://${host}${WELL_KNOWN_PATH}`),
      maxResponseBytes: MAX_DOCUMENT_BYTES,
    });
    if (response.status !== 200) throw new WellKnownError(`${host} answered ${response.status} for its discovery document.`);

    let document: unknown;
    try {
      document = JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      throw new WellKnownError(`The discovery document of ${host} is not JSON.`);
    }
    return parseWellKnownDocument(document);
  }
}
