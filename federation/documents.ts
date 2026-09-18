// The two unsigned documents (API-6). Spec: api-design.md §Capabilities, §Health.
import { toWireTimestamp } from "./errors";
import type { OpenYachtCapabilities } from "./generated";
import { PROTOCOL_VERSION } from "./well-known";

export interface CapabilitiesInput {
  /**
   * Optional protocol features this node implements. `features` lists optional
   * features only — the sale-listing schema and `updated_since` sync are the
   * baseline and have no flag. A flag is advertised when the feature works,
   * never in anticipation of it.
   */
  features: { subscriptions: boolean; charter_listings: boolean; media_hashes: boolean };
  limits: { page_size_max: number; rate_per_hour: number };
}

export function buildCapabilities(input: CapabilitiesInput): OpenYachtCapabilities {
  return {
    protocol_versions: [PROTOCOL_VERSION],
    features: { ...input.features },
    limits: { ...input.limits },
  };
}

/** Shape from the OpenAPI document's `Health` component — health has no schema file of its own. */
export interface HealthDocument {
  status: "ok";
  time: string;
}

/** Liveness only: it says the node answers, not that its dependencies are well. */
export function buildHealth(now: Date): HealthDocument {
  return { status: "ok", time: toWireTimestamp(now) };
}
