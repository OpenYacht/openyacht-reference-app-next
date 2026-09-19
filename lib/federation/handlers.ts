// The federation endpoints as plain Request → Response functions.
// Dependencies are injected, so the unit lane calls these directly with
// in-memory stand-ins and validates what they serve against the published
// schemas; app/**/route.ts files only bind them to the real store.
import {
  buildCapabilities,
  buildCollection,
  buildErrorEnvelope,
  buildHealth,
  buildWellKnownDocument,
  ERROR_STATUS,
  FeedQueryError,
  HEADER_NODE,
  IdentityConfigError,
  isIdentityHost,
  parseFeedQuery,
  pathAndQueryVariants,
  UUID_PATTERN,
  WELL_KNOWN_PATH,
  type Clock,
  type ErrorCode,
  type InboundRequest,
  type ListingFeedSource,
  type NodeIdentity,
  type PartnerRecord,
  type RateLimit,
  type RateLimiter,
  type VerificationResult,
} from "@/federation";
import type { NodeStore } from "@/lib/node/store";

/** What the signed endpoints need: verification, and somewhere to put what arrives. */
export interface InboundFederation {
  verify(request: InboundRequest): Promise<VerificationResult>;
  /** Stores a partnership request where the administrator who approves partners will see it. */
  recordPartnerRequest(domain: string, request: { message: string | null; contactEmail: string | null }): Promise<void>;
  /** One line per signed request: who, what, and how verification ended. Must never throw. */
  log(entry: {
    requestId: string;
    senderDomain: string | null;
    partnerDomain: string | null;
    method: string;
    path: string;
    outcome: string;
    status: number;
  }): Promise<void>;
}

export interface FederationDeps {
  /** Reads and validates the configured identity; throws IdentityConfigError. */
  identity(): NodeIdentity;
  store: NodeStore;
  clock: Clock;
  /** Published as `node.software`, e.g. `openyacht-reference-next/0.1.0`. */
  software: string;
  requestId(): string;
  /** Absent in tests that exercise only the unsigned documents. */
  inbound?: InboundFederation;
  /** This node's own listings, as one partner may see them. */
  listings?: ListingFeedSource;
  /** Counts signed requests per partner. Absent in tests that are not about limits. */
  rateLimiter?: RateLimiter;
  /** Counts discovery requests per client address. */
  discoveryLimiter?: RateLimiter;
}

// A flag is switched on by the change that makes the feature work, never ahead
// of it. `charter_listings` says the node implements the charter block of the
// wire schema — not that it holds any charter inventory.
const FEATURES = { subscriptions: false, charter_listings: true, media_hashes: true };
/** Signed requests a partner may make in an hour, unless it has been given a figure of its own. */
export const DEFAULT_RATE_PER_HOUR = 500;
const LIMITS = { page_size_max: 100, rate_per_hour: DEFAULT_RATE_PER_HOUR };
// What is advertised is what is enforced. The bucket is as large as the hourly
// rate, so a partner's first full sync can spend an hour's allowance at once.
const PARTNER_RATE: RateLimit = { capacity: LIMITS.rate_per_hour, perHour: LIMITS.rate_per_hour };
// The discovery document is public and unauthenticated, and partners cache it
// for a day: one a minute is ample, with room for a burst of retries.
const DISCOVERY_RATE: RateLimit = { capacity: 10, perHour: 60 };
const PAGE_SIZE_DEFAULT = 50;

// A discovery document cached by an intermediary would defeat the fresh
// refetch that makes key rotation coordination-free (FP-10). Partners cache
// it themselves, for 24 hours, keyed by domain.
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

// What a rejected sender is told. The reason a request failed verification is
// logged here, never sent: a precise answer is a guide to forging a better one.
const REJECTION_MESSAGES: Partial<Record<ErrorCode, string>> = {
  SIGNATURE_INVALID: "Signature verification failed after key refresh.",
  TIMESTAMP_OUT_OF_RANGE: "X-OpenYacht-Timestamp is outside ±300 seconds of this node's clock.",
  PARTNER_UNKNOWN: "This node does not know the sender, and could not verify it from its well-known document.",
  PARTNER_BLOCKED: "This node does not accept requests from the sender.",
  PARTNER_PROVISIONAL: "Partnership is pending approval; no listings are shared yet.",
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_EMAIL_LENGTH = 320;

interface GuardContext {
  identity: NodeIdentity;
  nodeUuid: string;
}

interface SignedContext extends GuardContext {
  partner: PartnerRecord;
  body: Uint8Array;
}

export function createFederationHandlers(deps: FederationDeps) {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

  const errorResponse = (code: ErrorCode, message: string, requestId = deps.requestId(), details?: Record<string, unknown>) =>
    json(buildErrorEnvelope({ code, message, details, requestId, now: deps.clock.now() }), ERROR_STATUS[code]);

  /** API-9: 429, the error envelope, and Retry-After in whole seconds. */
  const rateLimited = (retryAfterSeconds: number, requestId = deps.requestId()) =>
    json(
      buildErrorEnvelope({
        code: "RATE_LIMITED",
        message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
        details: { retry_after_seconds: retryAfterSeconds },
        requestId,
        now: deps.clock.now(),
      }),
      ERROR_STATUS.RATE_LIMITED,
      { "retry-after": String(retryAfterSeconds) },
    );

  /**
   * The address a discovery request came from, as the nearest proxy reported
   * it: the last entry of X-Forwarded-For. Earlier entries are whatever the
   * client chose to send. With no such header there is nothing to tell one
   * consumer from another, and the request is not counted.
   */
  const clientAddress = (request: Request) => request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null;

  /**
   * The gate in front of every federation route:
   *   1. misconfigured identity      → 500, logged loudly, nothing published;
   *   2. any host but the identity domain → bare 404, so the identity cannot fork;
   *   3. storage unreadable, or setup not completed → 503;
   *   4. identity domain changed since setup → 500. There is no rename: the
   *      domain is part of every canonical URI a partner has stored.
   */
  async function guarded(request: Request, respond: (context: GuardContext) => Promise<Response> | Response) {
    let identity: NodeIdentity;
    try {
      identity = deps.identity();
    } catch (error) {
      if (!(error instanceof IdentityConfigError)) throw error;
      console.error(`[openyacht] ${error.message}`);
      return new Response("Node identity is misconfigured; see the server log.", { status: 500 });
    }
    if (!isIdentityHost(request.headers.get("host"), identity.domain)) return new Response(null, { status: 404 });

    let state;
    try {
      state = await deps.store.getState();
    } catch (error) {
      // Storage that cannot be read is an outage, not a bug to surface as a
      // stack trace: say so, log why, and publish nothing.
      console.error(`[openyacht] Node state is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return json({ status: "unavailable" }, 503);
    }
    if (!state.setupCompleted || state.nodeUuid === null) {
      return json({ status: "setup_incomplete" }, 503);
    }
    if (state.identityDomain !== identity.domain) {
      console.error(
        `[openyacht] OPENYACHT_DOMAIN is "${identity.domain}" but this node was set up as "${state.identityDomain}". ` +
          "An identity domain cannot be changed: partners hold canonical URIs under the original. Federation endpoints are disabled.",
      );
      return new Response("Node identity domain changed since setup; see the server log.", { status: 500 });
    }
    return respond({ identity, nodeUuid: state.nodeUuid });
  }

  /**
   * A signed endpoint (FP-6): everything under /openyacht/v1/ except `health`
   * and `capabilities`. Verifies the request, applies the trust level, logs
   * the outcome, and only then runs the endpoint.
   *
   * `allowProvisional` is for the one route a not-yet-approved partner must be
   * able to reach: the partnership request itself.
   */
  function signed(request: Request, options: { allowProvisional: boolean }, respond: (context: SignedContext) => Promise<Response> | Response) {
    return guarded(request, async (context) => {
      const inbound = deps.inbound;
      if (inbound === undefined) return errorResponse("NOT_FOUND", "No such federation endpoint.");

      const requestId = deps.requestId();
      const url = new URL(request.url);
      const senderDomain = request.headers.get(HEADER_NODE)?.trim().toLowerCase() ?? null;
      const finish = async (response: Response, outcome: string, partnerDomain: string | null) => {
        await inbound.log({ requestId, senderDomain, partnerDomain, method: request.method, path: url.pathname, outcome, status: response.status });
        return response;
      };

      // The raw bytes, read once and before any parsing: the signature covers
      // exactly these, and re-serialised JSON would not reproduce them.
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length > MAX_BODY_BYTES)
        return finish(errorResponse("VALIDATION_ERROR", "The request body is too large.", requestId), "VALIDATION_ERROR", null);

      // Next.js hands a route handler a re-encoded query string (`:` arrives as
      // `%3A`), so the sender may have signed a spelling that is no longer
      // visible here. The verifier is given both.
      const result = await inbound.verify({
        method: request.method,
        pathAndQuery: pathAndQueryVariants(url.pathname + url.search),
        headers: request.headers,
        body,
      });
      if (!result.ok) {
        const details = result.code === "SIGNATURE_INVALID" || result.code === "PARTNER_UNKNOWN" ? { well_known: WELL_KNOWN_PATH } : undefined;
        console.warn(`[openyacht] rejected ${request.method} ${url.pathname} from ${senderDomain ?? "?"}: ${result.code} — ${result.reason}`);
        return finish(
          errorResponse(result.code, REJECTION_MESSAGES[result.code] ?? "The request was rejected.", requestId, details),
          result.code,
          null,
        );
      }

      // Counted only now, against a sender whose signature has verified: were
      // the claimed domain enough, anyone could spend a partner's allowance.
      const rate = await deps.rateLimiter?.take(result.partner.domain, PARTNER_RATE);
      if (rate !== undefined && !rate.allowed) return finish(rateLimited(rate.retryAfterSeconds, requestId), "RATE_LIMITED", result.partner.domain);

      // FP-13: until a person here approves the partner, nothing is shared with it.
      if (result.partner.trustLevel !== "verified" && !options.allowProvisional) {
        return finish(
          errorResponse("PARTNER_PROVISIONAL", REJECTION_MESSAGES.PARTNER_PROVISIONAL!, requestId),
          "PARTNER_PROVISIONAL",
          result.partner.domain,
        );
      }
      return finish(await respond({ ...context, partner: result.partner, body }), "ok", result.partner.domain);
    });
  }

  return {
    /** GET /.well-known/openyacht (FP-1, FP-5). */
    wellKnown: (request: Request) =>
      guarded(request, async ({ identity, nodeUuid }) => {
        const address = clientAddress(request);
        const rate = address === null ? undefined : await deps.discoveryLimiter?.take(address, DISCOVERY_RATE);
        if (rate !== undefined && !rate.allowed) return rateLimited(rate.retryAfterSeconds);
        return json(
          buildWellKnownDocument({
            identity,
            nodeUuid,
            software: deps.software,
            keys: await deps.store.listPublishedKeys(),
            // Listed only when the route is really served.
            optionalEndpoints: { partners: deps.inbound !== undefined },
            now: deps.clock.now(),
          }),
        );
      }),

    /** GET /openyacht/v1/capabilities — unsigned (API-6). */
    capabilities: (request: Request) => guarded(request, () => json(buildCapabilities({ features: FEATURES, limits: LIMITS }))),

    /** GET /openyacht/v1/health — unsigned, liveness only (API-6). */
    health: (request: Request) => guarded(request, () => json(buildHealth(deps.clock.now()))),

    /**
     * POST /openyacht/v1/partners/request — lifecycle step 1. Accepted from any
     * sender whose signature verifies, whatever its trust level: this is how an
     * unknown node introduces itself. Answers 202: the request has been taken,
     * and a person decides.
     *
     * The body is read leniently. A sender that omits a field has still
     * introduced itself, and by this point it is already registered — refusing
     * the request while keeping the sender would be the one wrong combination.
     */
    partnersRequest: (request: Request) =>
      signed(request, { allowProvisional: true }, async ({ partner, body }) => {
        let parsed: unknown = null;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(Buffer.from(body).toString("utf8"));
          } catch {
            return errorResponse("VALIDATION_ERROR", "The request body is not JSON.");
          }
        }
        const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null);
        await deps.inbound!.recordPartnerRequest(partner.domain, {
          message: text(fields.message, MAX_MESSAGE_LENGTH),
          contactEmail: text(fields.contact_email, MAX_EMAIL_LENGTH),
        });
        return json({ status: partner.trustLevel === "verified" ? "accepted" : "pending", trust_level: partner.trustLevel }, 202);
      }),

    /**
     * GET /openyacht/v1/listings — this node's own listings, as the requesting
     * partner may see them (API-2, API-3, API-5). Own listings only: copies of
     * other nodes' listings are never served onward (ID-6).
     */
    listings: (request: Request) =>
      signed(request, { allowProvisional: false }, async ({ partner }) => {
        if (deps.listings === undefined) return errorResponse("NOT_FOUND", "No such federation endpoint.");
        let query;
        try {
          query = parseFeedQuery(new URL(request.url).searchParams, { pageSizeDefault: PAGE_SIZE_DEFAULT, pageSizeMax: LIMITS.page_size_max });
        } catch (error) {
          if (!(error instanceof FeedQueryError)) throw error;
          return errorResponse("VALIDATION_ERROR", error.message);
        }
        const { items, next, generatedAt } = await deps.listings.page(partner.domain, query);
        return json(buildCollection(items, next, generatedAt));
      }),

    /**
     * GET /openyacht/v1/listings/{uuid} — the dereference target of a canonical
     * URI. One answer, NOT_FOUND, covers a listing that does not exist, one that
     * is a draft, and one this partner may not see: the wording is identical, so
     * a partner learns nothing by trying UUIDs.
     */
    listing: (request: Request, uuid: string) =>
      signed(request, { allowProvisional: false }, async ({ partner }) => {
        const found = deps.listings !== undefined && UUID_PATTERN.test(uuid) ? await deps.listings.one(partner.domain, uuid) : null;
        if (found === null) return errorResponse("NOT_FOUND", "No such listing.");
        if (found === "gone") return errorResponse("GONE", "This listing ended more than twelve months ago.");
        return json(found);
      }),

    /**
     * A known path asked with the wrong method: 405 and an Allow header. The
     * body is empty on purpose — the error envelope's closed list of codes has
     * none for this, and a made-up code would not be schema-valid.
     */
    methodNotAllowed: (request: Request, allowed: string[]) =>
      guarded(request, () => new Response(null, { status: 405, headers: { allow: allowed.join(", "), "cache-control": "no-store" } })),

    /** Anything else under /openyacht/v1/ answers in the error envelope, never an HTML page (API-9). */
    notFound: (request: Request) => guarded(request, () => errorResponse("NOT_FOUND", "No such federation endpoint.")),
  };
}
