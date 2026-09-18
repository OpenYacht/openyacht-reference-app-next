// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.

/**
 * Marker for a listing that became invisible to the requesting partner (withdrawn, sold, or unshared), delivered in /listings sync results and subscription pushes. The prose spec (spec/api-design.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective.
 */
export interface OpenYachtTombstone {
  /**
   * The listing's canonical URI — unchanged for the life of the listing, tombstone included.
   */
  id: string;
  tombstone: true;
  status: "active" | "under_offer" | "sold" | "withdrawn";
  updated_at: string;
}
