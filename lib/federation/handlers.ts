// The unsigned federation endpoints as plain Request → Response functions.
// Dependencies are injected, so the unit lane calls these directly with an
// in-memory store and validates what they serve against the published schemas;
// app/**/route.ts files only bind them to the real store.
import {
  buildCapabilities,
  buildErrorEnvelope,
  buildHealth,
  buildWellKnownDocument,
  ERROR_STATUS,
  IdentityConfigError,
  isIdentityHost,
  type Clock,
  type ErrorCode,
  type NodeIdentity,
} from "@/federation";
import type { NodeStore } from "@/lib/node/store";

export interface FederationDeps {
  /** Reads and validates the configured identity; throws IdentityConfigError. */
  identity(): NodeIdentity;
  store: NodeStore;
  clock: Clock;
  /** Published as `node.software`, e.g. `openyacht-reference-next/0.1.0`. */
  software: string;
  requestId(): string;
}

// No optional feature is advertised yet: a flag is switched on by the change
// that makes the feature work, never ahead of it.
const FEATURES = { subscriptions: false, charter_listings: false, media_hashes: false };
const LIMITS = { page_size_max: 100, rate_per_hour: 500 };

// A discovery document cached by an intermediary would defeat the fresh
// refetch that makes key rotation coordination-free (FP-10). Partners cache
// it themselves, for 24 hours, keyed by domain.
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function createFederationHandlers(deps: FederationDeps) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

  const errorResponse = (code: ErrorCode, message: string) =>
    json(buildErrorEnvelope({ code, message, requestId: deps.requestId(), now: deps.clock.now() }), ERROR_STATUS[code]);

  /**
   * The gate in front of every federation route:
   *   1. misconfigured identity      → 500, logged loudly, nothing published;
   *   2. any host but the identity domain → bare 404, so the identity cannot fork;
   *   3. storage unreadable, or setup not completed → 503;
   *   4. identity domain changed since setup → 500. There is no rename: the
   *      domain is part of every canonical URI a partner has stored.
   */
  async function guarded(request: Request, respond: (context: { identity: NodeIdentity; nodeUuid: string }) => Promise<Response> | Response) {
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

  return {
    /** GET /.well-known/openyacht (FP-1, FP-5). */
    wellKnown: (request: Request) =>
      guarded(request, async ({ identity, nodeUuid }) =>
        json(
          buildWellKnownDocument({
            identity,
            nodeUuid,
            software: deps.software,
            keys: await deps.store.listPublishedKeys(),
            now: deps.clock.now(),
          }),
        ),
      ),

    /** GET /openyacht/v1/capabilities — unsigned (API-6). */
    capabilities: (request: Request) => guarded(request, () => json(buildCapabilities({ features: FEATURES, limits: LIMITS }))),

    /** GET /openyacht/v1/health — unsigned, liveness only (API-6). */
    health: (request: Request) => guarded(request, () => json(buildHealth(deps.clock.now()))),

    /** Anything else under /openyacht/v1/ answers in the error envelope, never an HTML page (API-9). */
    notFound: (request: Request) => guarded(request, () => errorResponse("NOT_FOUND", "No such federation endpoint.")),
  };
}
