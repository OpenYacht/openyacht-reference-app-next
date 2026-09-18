// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.

/**
 * Response of unsigned GET /openyacht/v1/capabilities. The prose spec (spec/api-design.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective. The features object lists optional protocol features only; absence of a flag means the capability is part of the mandatory baseline, so consumers check flags, and unknown flags (added by minor versions) validate as booleans.
 */
export interface OpenYachtCapabilities {
  /**
   * @minItems 1
   */
  protocol_versions: string[];
  features: {
    subscriptions?: boolean;
    charter_listings?: boolean;
    media_hashes?: boolean;
    [k: string]: boolean | undefined;
  };
  limits: {
    page_size_max?: number;
    rate_per_hour?: number;
    [k: string]: number | undefined;
  };
}
