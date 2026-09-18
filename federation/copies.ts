// Turning a received listing into a stored copy. Spec: yacht-identity.md
// §What everyone else holds (ID-3 … ID-10), listing-schema.md (LS-5, LS-12),
// api-design.md §Implementation Notes (acceptance policy).
import type { AcceptancePolicy, CopyDisplayState, HtmlSanitiser, SlugRegistry } from "./ports";

/**
 * The payload as it will be stored: identical to what the authority sent
 * (ID-5) except that every `descriptions[].content` is sanitised. Sanitising
 * on receipt, before storage, means no later code path — a new page, an
 * export, an API — can render a partner's markup unsanitised by forgetting to.
 */
export function sanitisePayload(payload: Record<string, unknown>, sanitiser: HtmlSanitiser): Record<string, unknown> {
  if (!Array.isArray(payload.descriptions)) return payload;
  return {
    ...payload,
    descriptions: payload.descriptions.map((description) =>
      isRecord(description) && typeof description.content === "string"
        ? { ...description, content: sanitiser.sanitise(description.content) }
        : description,
    ),
  };
}

/**
 * HIN and IMO — the two identifiers the spec treats as naming the same
 * physical vessel — normalised so that spacing and case cannot hide a match.
 * MMSI and official number follow the registration, not the hull, and are
 * deliberately not used (yacht-identity.md §Vessel Identity).
 */
export function hardIdentifiers(payload: Record<string, unknown>): string[] {
  const vessel = isRecord(payload.vessel) ? payload.vessel : {};
  const identifiers: string[] = [];
  for (const field of ["hin", "imo"] as const) {
    const value = vessel[field];
    if (typeof value !== "string") continue;
    const normalised = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalised !== "") identifiers.push(`${field}:${normalised}`);
  }
  return identifiers;
}

/**
 * LS-12: builder and category slugs are checked against the vendored
 * registries. An unknown slug means the sender is on a newer registry (or in
 * error): the name is still usable, and the slug is reported so the registry
 * copy can be updated. No mapping is ever invented.
 */
export function unknownSlugs(payload: Record<string, unknown>, registry: SlugRegistry): string[] {
  const unknown: string[] = [];
  const builder = isRecord(payload.vessel) && isRecord(payload.vessel.builder) ? payload.vessel.builder.slug : null;
  if (typeof builder === "string" && !registry.hasBuilder(builder)) unknown.push(`builder:${builder}`);
  const category = isRecord(payload.specifications) && isRecord(payload.specifications.category) ? payload.specifications.category.slug : null;
  if (typeof category === "string" && !registry.hasCategory(category)) unknown.push(`category:${category}`);
  return unknown;
}

export interface DisplayDecision {
  displayState: CopyDisplayState;
  heldReasons: string[];
}

/**
 * Whether a synchronised copy is displayed. The policy is the partner's; the
 * first check is not a policy at all and cannot be overridden by one: a
 * listing whose `usage.display` is false is never displayed (ID-10).
 *
 * Vessel-identity conflicts and partner staleness are the other two things no
 * policy overrides. They are not decided here because they change without the
 * copy changing; they are applied on top of this decision when displaying.
 */
export function decideDisplay(payload: Record<string, unknown>, policy: AcceptancePolicy): DisplayDecision {
  const reasons: string[] = [];
  const usage = isRecord(payload.usage) ? payload.usage : {};
  if (usage.display !== true) reasons.push("The authority's usage terms do not allow display.");

  if (policy === "hold") reasons.push("This partner's listings are held for review.");
  if (policy === "accept_matching") reasons.push(...completenessGaps(payload));

  return { displayState: reasons.length === 0 ? "published" : "held", heldReasons: reasons };
}

/**
 * The "accept matching" criterion is completeness. Field-group gating (LS-14)
 * means a legitimately shared listing may arrive with its price or its imagery
 * withheld, and that is usually what an operator does not want to publish
 * unseen.
 */
function completenessGaps(payload: Record<string, unknown>): string[] {
  const gaps: string[] = [];
  const media = isRecord(payload.media) ? payload.media : {};
  if (!isRecord(media.profile)) gaps.push("No profile image.");

  if (payload.type === "charter") {
    const rates = isRecord(payload.charter) ? payload.charter.rates : null;
    if (!Array.isArray(rates) || rates.length === 0) gaps.push("No charter rates.");
  } else {
    const price = isRecord(payload.listing) && isRecord(payload.listing.price) ? payload.listing.price : {};
    if (typeof price.amount !== "string" && price.on_application !== true) gaps.push("No asking price.");
  }
  return gaps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
