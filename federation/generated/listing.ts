// GENERATED FILE — do not edit. Run `pnpm generate:types`.
// Source: protocol/schemas/v1 (https://github.com/OpenYacht/protocol @ 734822c)
// Private `x_` extension fields are valid on the wire but deliberately untyped.

/**
 * Full listing payload as served at GET /openyacht/v1/listings/{uuid} and inside /listings collection responses. The prose spec (spec/listing-schema.md) is normative; this schema is normative for JSON shape only — on any conflict the prose wins and this schema is defective. Deliberately not encoded here: builder-slug registry membership, field-group gating semantics, the 24-hour update obligation, HTML sanitisation of descriptions[].content, request signing. Conventions: every field is present (complete objects — null, never absent), and objects admit x_-prefixed private extension fields only.
 */
export type OpenYachtListing = {
  id: CanonicalUri;
  type: "sale" | "charter";
  /**
   * draft exists in the lifecycle but is never distributed, so it is invalid on the wire.
   */
  status: "active" | "under_offer" | "sold" | "withdrawn";
  updated_at: Timestamp;
  listed_at: Timestamp | null;
  condition: "new" | "used" | null;
  /**
   * Mandate metadata. ⚠ Open question 5: whether this belongs on the wire at all is unresolved; a counter-proposal (a single self-attested CA-on-file flag) is on the table.
   */
  agreement: {
    type: "central" | "exclusive" | "open" | null;
    co_brokerage: boolean | null;
  } | null;
  vessel: Vessel;
  listing: Listing;
  specifications: Specifications;
  descriptions: Description[];
  features: Feature[];
  media: Media;
  /**
   * Charter-only block; null when type is sale (enforced by the type conditional below).
   */
  charter: Charter | null;
  usage: Usage;
  compliance: Compliance;
};
/**
 * Canonical listing URI minted by the authority: https://{authority-domain}/openyacht/v1/listings/{uuid}. Immutable; compared as an opaque string.
 */
export type CanonicalUri = string;
/**
 * RFC 3339 UTC, Z-suffixed.
 */
export type Timestamp = string;
/**
 * Monetary amount as a string of decimal digits with optional . separator. Money is never a float.
 */
export type MoneyAmount = string;
/**
 * ISO 4217 currency code.
 */
export type Currency = string;
/**
 * ISO 3166-1 alpha-2 country code.
 */
export type Country = string;
export type Uri = string;
/**
 * Date without time-of-day, YYYY-MM-DD.
 */
export type Date = string;
/**
 * Lowercase hex SHA-256 of the file's raw bytes.
 */
export type Sha256 = string;

/**
 * Real-world identity of the physical boat, for matching, not authority. All fields nullable; nulls that say unknown beat guesses.
 */
export interface Vessel {
  hin: string | null;
  imo: string | null;
  mmsi: string | null;
  official_number: string | null;
  /**
   * slug, when non-null, MUST be present in the vendored builder registry (registry/builders.json) — a prose rule this schema deliberately does not encode.
   */
  builder: Vocab | null;
  model: Vocab | null;
  year_built: number | null;
  refit_year: number | null;
  loa_m: number | null;
  previous_names: string[];
}
/**
 * Shared vocabulary shape: name is display truth, slug the interoperability mechanism. A consumer that does not recognise a slug falls back to the name.
 */
export interface Vocab {
  name: string;
  slug: string | null;
}
/**
 * The commercial facts of this mandate.
 */
export interface Listing {
  name: string;
  summary: string | null;
  /**
   * null on charter listings (charter pricing is charter.rates); enforced by the top-level conditional.
   */
  price: Price | null;
  /**
   * Most recent first; the first entry always matches the current price (prose rule, not encoded).
   */
  price_history: PriceHistoryEntry[];
  location: Location | null;
  brokers: Broker[];
}
export interface Price {
  amount: MoneyAmount | null;
  currency: Currency | null;
  on_application: boolean;
  starting_price: boolean;
}
export interface PriceHistoryEntry {
  amount: MoneyAmount;
  currency: Currency;
  changed_at: Timestamp;
}
export interface Location {
  display: string;
  city: string | null;
  state: string | null;
  country: Country | null;
  marina: string | null;
  coordinates: {
    lat: number;
    lon: number;
  } | null;
}
/**
 * Attribution and contact, not identity — brokerage identity is the authority node itself.
 */
export interface Broker {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  photo_url: Uri | null;
}
/**
 * One flat object; canonical metric units, one unit per concept (_m, _kg, _l, _kn, _nmi, _lph; gross_tonnage dimensionless).
 */
export interface Specifications {
  beam_m: number | null;
  draft_max_m: number | null;
  draft_min_m: number | null;
  lwl_m: number | null;
  lod_m: number | null;
  bridge_clearance_m: number | null;
  gross_tonnage: number | null;
  displacement_kg: number | null;
  fuel_capacity_l: number | null;
  water_capacity_l: number | null;
  holding_tank_l: number | null;
  cruise_speed_kn: number | null;
  max_speed_kn: number | null;
  range_nmi: number | null;
  fuel_consumption_lph: number | null;
  hull_material: string | null;
  superstructure_material: string | null;
  deck_material: string | null;
  hull_shape:
    | "planing"
    | "semi_displacement"
    | "displacement"
    | "hydrofoil"
    | "catamaran"
    | "trimaran"
    | null;
  hull_color: string | null;
  naval_architect: string | null;
  exterior_designer: string | null;
  interior_designer: string | null;
  fuel_type: "diesel" | "petrol" | "electric" | "hybrid" | null;
  flag: string | null;
  registry_port: string | null;
  /**
   * Required (non-null) per the prose — the one specification every listing can state.
   */
  power_or_sail: "power" | "sail";
  /**
   * slug, when non-null, MUST be present in the vendored category registry (registry/categories.json) — a prose rule this schema deliberately does not encode.
   */
  category: Vocab | null;
  cabins: number | null;
  sleeps: number | null;
  heads: number | null;
  /**
   * Guests carried under way — the regulatory limit for a commercially registered yacht, commonly 12.
   */
  guests_cruising: number | null;
  /**
   * Guests carried while static (at anchor or dockside) — the 'entertaining' or 'dockside' capacity the market quotes separately from the cruising limit. Typically higher than guests_cruising; null when the authority does not hold it.
   */
  guests_entertaining: number | null;
  cabin_config: CabinConfig | null;
  berth_config: BerthConfig | null;
  crew_accommodation: CrewAccommodation | null;
  engines: Engine[];
  generators: Generator[];
  tenders: string | null;
}
/**
 * Room-level properties; a convertible cabin can be split/re-made.
 */
export interface CabinConfig {
  double: number | null;
  twin: number | null;
  triple: number | null;
  single: number | null;
  convertible: number | null;
}
/**
 * Sleeping surfaces in the typical/default makeup.
 */
export interface BerthConfig {
  king: number | null;
  queen: number | null;
  double: number | null;
  twin: number | null;
  single: number | null;
  pullman: number | null;
  bunk: number | null;
}
export interface CrewAccommodation {
  cabins: number | null;
  berths: number | null;
  layout: string | null;
}
export interface Engine {
  make: string | null;
  model: string | null;
  year: number | null;
  type: "inboard" | "outboard" | "saildrive" | "pod" | "jet" | null;
  drive_type: string | null;
  power_hp: number | null;
  power_kw: number | null;
  fuel_type: "diesel" | "petrol" | "electric" | "hybrid" | null;
  hours: number | null;
  hours_recorded_at: Date | null;
  location: string | null;
}
export interface Generator {
  make: string | null;
  model: string | null;
  power_kw: number | null;
  hours: number | null;
  hours_recorded_at: Date | null;
}
/**
 * content is restricted HTML (prose Conventions §7); consumers MUST sanitise before rendering regardless — not encodable here.
 */
export interface Description {
  section: string;
  content: string;
}
export interface Feature {
  category: string | null;
  name: string;
  slug: string | null;
  quantity: number | null;
}
/**
 * Typed collections, not one mixed array. profile: null is the only correct representation of a listing with no imagery — placeholders are prohibited.
 */
export interface Media {
  profile: Profile | null;
  gallery: GalleryItem[];
  layouts: LayoutItem[];
  videos: VideoItem[];
  tours: TourItem[];
  documents: DocumentItem[];
}
/**
 * The explicit hero image. thumbnail_url is required non-null whenever profile is present.
 */
export interface Profile {
  url: Uri;
  sha256: Sha256 | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  thumbnail_url: Uri;
}
/**
 * thumbnail_url is nullable: null means no small rendition is served and consumers derive from url.
 */
export interface GalleryItem {
  url: Uri;
  sha256: Sha256 | null;
  category: "exterior" | "interior" | "lifestyle" | "crew" | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  sort: number;
  thumbnail_url: Uri | null;
}
/**
 * thumbnail_url is nullable: null means no small rendition is served and consumers derive from url.
 */
export interface LayoutItem {
  url: Uri;
  sha256: Sha256 | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  sort: number;
  thumbnail_url: Uri | null;
}
/**
 * MAY point to external platforms; sha256 is null for external URLs, required for authority-hosted files (prose rule).
 */
export interface VideoItem {
  url: Uri;
  sha256: Sha256 | null;
  caption: string | null;
  sort: number;
}
export interface TourItem {
  url: Uri;
  caption: string | null;
  sort: number;
}
export interface DocumentItem {
  url: Uri;
  sha256: Sha256 | null;
  caption: string | null;
  sort: number;
}
export interface Charter {
  rates: Rate[];
  operating_areas: OperatingArea[];
  summer_base_port: string | null;
  winter_base_port: string | null;
  crew: CrewMember[];
}
export interface Rate {
  /**
   * summer | winter | a free-text label for special periods — deliberately not a closed enum.
   */
  season: string;
  rate_type: "weekly" | "daily";
  amount_min: MoneyAmount | null;
  amount_max: MoneyAmount | null;
  currency: Currency | null;
  contract_terms: string | null;
  apa_percent: number | null;
  vat_percent: number | null;
  valid_from: Date | null;
  valid_to: Date | null;
}
export interface OperatingArea {
  name: string;
  slug: string | null;
  season: string | null;
}
/**
 * Crew bios and photos are personal data; distribution requires a charter-manager/captain attestation and inherits the listing's usage terms (prose rules).
 */
export interface CrewMember {
  role: string;
  name: string | null;
  nationality: string | null;
  bio: string | null;
  photo_url: Uri | null;
  /**
   * true represents an unannounced position (name et al. null).
   */
  tba: boolean;
}
/**
 * Terms under which the receiving brokerage may use the data; normative definition in spec/yacht-identity.md.
 */
export interface Usage {
  display: boolean;
  attribution_required: boolean;
  attribution_text: string | null;
  marketing_materials: boolean;
  ai_indexing: boolean;
  expires_with_listing: boolean;
}
export interface Compliance {
  not_for_sale_to_us_residents_in_us_waters: boolean | null;
  /**
   * Free text, deliberately not an enum; paid / not_paid / exempt are suggested values only. ⚠ Open question 3.
   */
  vat_status: string | null;
  ce_certified: boolean | null;
  mca_compliant: boolean | null;
  classification: ClassificationEntry[];
}
export interface ClassificationEntry {
  society: string;
  notation: string | null;
  next_survey_due: Date | null;
}
