import "server-only";
import { randomUUID } from "node:crypto";
import { parseNodeIdentity, systemClock } from "@/federation";
import { supabaseNodeStore } from "@/lib/node/store";
import { createFederationHandlers } from "./handlers";
import { inboundFederation } from "./inbound";
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
});
