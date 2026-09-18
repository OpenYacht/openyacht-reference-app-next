// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.
import type {OpenYachtListing} from "./listing";
import type {OpenYachtTombstone} from "./tombstone";

/**
 * Response envelope of GET /openyacht/v1/listings: a page of listings and tombstones plus sync metadata. The prose spec (spec/api-design.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective.
 */
export interface OpenYachtListingsCollection {
  data: (OpenYachtListing | OpenYachtTombstone)[];
  meta: {
    /**
     * Opaque pagination cursor. Absent (not null) on the last page — the one deliberate absence in the protocol.
     */
    next_cursor?: string;
    generated_at: string;
    protocol_version: string;
  };
}
