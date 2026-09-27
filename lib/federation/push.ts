import "server-only";
import { pushPayload } from "@/lib/listings/feed-source";
import { serviceClient } from "@/lib/supabase/service";
import { postToCallback } from "./consumer";

// The delivery worker for push subscriptions (API-10). pg_cron calls it every
// minute while pushes are on and something is due (private.request_push). The
// queue, the backoff and the 24-hour ceiling live in the database; this sends.

interface Claimed {
  partner_id: number;
  listing_id: number;
  changed_at: string;
  callback: string;
  domain: string;
}

const BATCH = 50;

export async function deliverDuePushes(): Promise<Record<string, number>> {
  const db = serviceClient();
  const { data, error } = await db.rpc("claim_push_deliveries", { p_limit: BATCH });
  if (error) throw new Error(`Cannot claim deliveries: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const claim of data as Claimed[]) {
    let delivered = false;
    let failure: string | null = null;
    try {
      const payload = await pushPayload(claim.partner_id, claim.listing_id);
      if (payload === null) {
        // Nothing to tell this partner (a draft, or never seen): done.
        delivered = true;
      } else {
        const response = await postToCallback(new URL(claim.callback), payload);
        delivered = response.status >= 200 && response.status < 300;
        if (!delivered) failure = `${response.status} ${response.errorCode ?? ""}`.trim();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const { data: outcome, error: finishError } = await db.rpc("finish_push_delivery", {
      p_partner_id: claim.partner_id,
      p_listing_id: claim.listing_id,
      p_claimed_changed_at: claim.changed_at,
      p_delivered: delivered,
      p_error: failure,
    });
    if (finishError) throw new Error(`Cannot record a delivery: ${finishError.message}`);
    if (outcome === "abandoned") console.warn(`[openyacht] push to ${claim.domain} abandoned after 24 hours: ${failure}`);
    counts[outcome as string] = (counts[outcome as string] ?? 0) + 1;
  }
  return counts;
}
