// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.

/**
 * Error envelope for all federation endpoints. The prose spec (spec/api-design.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective. HTTP status mappings are a prose rule.
 */
export interface OpenYachtError {
  error: {
    code:
      | "SIGNATURE_INVALID"
      | "TIMESTAMP_OUT_OF_RANGE"
      | "PARTNER_UNKNOWN"
      | "PARTNER_BLOCKED"
      | "PARTNER_PROVISIONAL"
      | "NOT_FOUND"
      | "GONE"
      | "RATE_LIMITED"
      | "VALIDATION_ERROR"
      | "VERSION_UNSUPPORTED";
    message: string;
    /**
     * Code-specific supplementary detail; shape is free-form.
     */
    details?: {} | null;
  };
  meta: {
    request_id: string;
    time: string;
  };
}
