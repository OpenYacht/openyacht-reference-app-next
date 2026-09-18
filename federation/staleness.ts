// Staleness (FP-15) and polling backoff. Spec: federation-protocol.md §Health
// and Failure Handling.

export interface StalenessThresholds {
  /** Flag a partner's listings as stale after this long unreachable. RECOMMENDED: 7 days. A MUST (FP-15). */
  staleAfterDays: number;
  /** Stop displaying them publicly after this long. A SHOULD: 30 days. */
  hideAfterDays: number;
}

export const DEFAULT_STALENESS: StalenessThresholds = { staleAfterDays: 7, hideAfterDays: 30 };

export type Freshness = "fresh" | "stale" | "hidden";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How current a partner's copies are.
 *
 * The 30-day rule carries more weight than its SHOULD suggests. Copies are
 * normally removed by tombstones, and a tombstone needs the authority to still
 * be answering: a node that vanishes never sends one. This is the only
 * mechanism that ever stops a vanished partner's inventory being displayed.
 *
 * Age is measured from the last successful sync, or — for a partner that has
 * never once synced — from when it was added. Without that fallback a
 * partnership that never succeeded would never age at all.
 */
export function partnerFreshness(
  partner: { lastOkAt: Date | null; createdAt: Date },
  now: Date,
  thresholds: StalenessThresholds = DEFAULT_STALENESS,
): Freshness {
  const ageDays = (now.getTime() - (partner.lastOkAt ?? partner.createdAt).getTime()) / DAY_MS;
  if (ageDays >= thresholds.hideAfterDays) return "hidden";
  if (ageDays >= thresholds.staleAfterDays) return "stale";
  return "fresh";
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Exponential backoff for an unreachable partner, capped at 24 hours: one
 * hour after the first failure, doubling from there.
 */
export function nextAttemptAt(partner: { consecutiveFailures: number; lastAttemptAt: Date | null }): Date | null {
  if (partner.consecutiveFailures === 0 || partner.lastAttemptAt === null) return null;
  const delay = Math.min(HOUR_MS * 2 ** (partner.consecutiveFailures - 1), 24 * HOUR_MS);
  return new Date(partner.lastAttemptAt.getTime() + delay);
}

export function isSyncDue(partner: { consecutiveFailures: number; lastAttemptAt: Date | null }, now: Date): boolean {
  const next = nextAttemptAt(partner);
  return next === null || next.getTime() <= now.getTime();
}
