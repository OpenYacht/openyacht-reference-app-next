import "server-only";
import type { RateDecision, RateLimit, RateLimiter } from "@/federation";
import { serviceClient } from "@/lib/supabase/service";

/**
 * Per-partner buckets kept in the database, so that every instance of the
 * application counts against the same one. The limit handed in is the node's
 * default; a partner given a figure of its own (federation_partners.rate_per_hour)
 * is held to that instead, inside take_rate_limit_token().
 */
export const partnerRateLimiter: RateLimiter = {
  async take(partnerDomain: string, limit: RateLimit): Promise<RateDecision> {
    const { data, error } = await serviceClient().rpc("take_rate_limit_token", { p_domain: partnerDomain, p_default_per_hour: limit.perHour });
    if (error) {
      // A limiter that cannot count must not become an outage for every
      // partner: let the request through, and say so.
      console.error(`[openyacht] rate limiter unavailable, request allowed: ${error.message}`);
      return { allowed: true };
    }
    const retryAfterSeconds = Number(data);
    return retryAfterSeconds > 0 ? { allowed: false, retryAfterSeconds } : { allowed: true };
  },
};
