import "server-only";
import { randomUUID } from "node:crypto";
import { InMemoryRateLimiter, parseNodeIdentity, systemClock } from "@/federation";
import { supabaseNodeStore } from "@/lib/node/store";
import { supabaseFeedSource } from "@/lib/listings/feed-source";
import { createFederationHandlers } from "./handlers";
import { inboundFederation } from "./inbound";
import { partnerRateLimiter } from "./rate-limiter";
import { SOFTWARE } from "./software";

/** The federation handlers bound to the real environment and database. */
export const federation = createFederationHandlers({
  // Parsed per request rather than at import: a misconfigured identity must
  // fail the federation routes, not the build or the admin UI's boot.
  identity: () => parseNodeIdentity(process.env),
  store: supabaseNodeStore,
  clock: systemClock,
  software: SOFTWARE,
  requestId: () => `req_${randomUUID().replaceAll("-", "")}`,
  inbound: inboundFederation,
  listings: supabaseFeedSource,
  rateLimiter: partnerRateLimiter,
  // Per process, so approximate wherever several instances run. That is enough
  // here: the document is public and cheap, and the limit is a courtesy bound
  // on it, not what stands between a partner and its allowance.
  discoveryLimiter: new InMemoryRateLimiter(),
});
