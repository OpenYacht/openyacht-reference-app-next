import "server-only";
import { randomUUID } from "node:crypto";
import { parseNodeIdentity, systemClock } from "@/federation";
import { supabaseNodeStore } from "@/lib/node/store";
import packageJson from "@/package.json";
import { createFederationHandlers } from "./handlers";

export const SOFTWARE = `openyacht-reference-next/${packageJson.version}`;

/** The federation handlers bound to the real environment and database. */
export const federation = createFederationHandlers({
  // Parsed per request rather than at import: a misconfigured identity must
  // fail the federation routes, not the build or the admin UI's boot.
  identity: () => parseNodeIdentity(process.env),
  store: supabaseNodeStore,
  clock: systemClock,
  software: SOFTWARE,
  requestId: () => `req_${randomUUID().replaceAll("-", "")}`,
});
