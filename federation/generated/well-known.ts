// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.

/**
 * The document every node serves at GET /.well-known/openyacht: identity, keys, and endpoint map. The prose spec (spec/federation-protocol.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective. TLS requirements, caching, and rate limits are prose rules.
 */
export interface OpenYachtDiscoveryDocument {
  openyacht: string;
  /**
   * @minItems 1
   */
  protocol_versions: string[];
  node: {
    /**
     * Generated at install time. Not a trust anchor — it detects that a domain now hosts a different installation.
     */
    uuid: string;
    name: string;
    software: string | null;
    website: string | null;
  };
  /**
   * An array so rotation can overlap; verifiers select by the request's key ID.
   *
   * @minItems 1
   */
  keys: {
    /**
     * First 16 hex characters of the SHA-256 of the raw 32-byte public key.
     */
    key_id: string;
    algorithm: "ed25519";
    /**
     * Base64 of the raw 32-byte Ed25519 public key.
     */
    public_key: string;
    created_at: string;
  }[];
  /**
   * Map of the endpoints this node actually serves. listings, health, and capabilities are the mandatory baseline; partners and subscriptions appear when served (subscriptions is capability-gated, and a node may handle partnering out of band). Acceptance finding, 2026-08: the first live node serves only the baseline three.
   */
  endpoints: {
    listings: string;
    partners?: string;
    subscriptions?: string;
    health: string;
    capabilities: string;
  };
  generated_at: string;
}
