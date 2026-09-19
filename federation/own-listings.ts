// Serialising this node's own listings for a partner. Spec: listing-schema.md,
// yacht-identity.md §Listing Identity, §Lifecycle, §Sharing Permissions.
//
// Two rules shape this file.
//   LS-1  Every field defined for the listing's type is emitted, with `null` or
//         `[]` where a value is unknown or withheld. Consumers never branch on
//         field presence. So every block is built from a complete template of
//         defaults, and only the template's own keys are copied from the
//         stored data — nothing the schema does not define can leak out.
//   LS-14 What a partner may not see is nulled or emptied here, on the server.
//         There is no "please ignore this field".
import { toWireTimestamp } from "./errors";
import type {
  BerthConfig,
  Broker,
  CabinConfig,
  Charter,
  ClassificationEntry,
  Compliance,
  CrewAccommodation,
  CrewMember,
  Description,
  DocumentItem,
  Engine,
  Feature,
  GalleryItem,
  Generator,
  LayoutItem,
  Location,
  Media,
  OpenYachtListing,
  OpenYachtTombstone,
  OperatingArea,
  PriceHistoryEntry,
  Profile,
  Rate,
  Specifications,
  TourItem,
  Usage,
  Vessel,
  VideoItem,
} from "./generated";
import { API_BASE_PATH } from "./well-known";

export class ListingError extends Error {}

/** `draft` exists in the lifecycle and never on the wire (LS-7). */
export type ListingStatus = "draft" | "active" | "under_offer" | "sold" | "withdrawn";

/** The field groups an authority grants or withholds per partner (LS-14). */
export const FIELD_GROUPS = ["pricing", "location_exact", "media_original", "documents", "vessel_identifiers", "history"] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

type Sparse<T> = { [K in keyof T]?: T[K] | undefined };

/** A media item as stored: the wire item, plus the hi-res original that `media_original` unlocks. */
type WithOriginal<T> = Sparse<T> & {
  url: string;
  original?: { url: string; sha256: string | null; width: number | null; height: number | null } | null;
};

/**
 * One of this node's own listings, as the host stores it. The nested blocks
 * are the wire shapes, sparsely filled: serialising completes them.
 */
export interface OwnListing {
  /** Minted once, at creation, never reused (ID-1). */
  uuid: string;
  /** Chosen at creation and immutable. A vessel for sale and for charter is two listings. */
  type: "sale" | "charter";
  status: ListingStatus;
  /** Last change to what a partner can see of this listing. Drives `updated_since`. */
  updatedAt: Date;
  listedAt: Date | null;
  condition: "new" | "used" | null;
  agreement: { type: "central" | "exclusive" | "open" | null; co_brokerage: boolean | null } | null;
  vessel: Sparse<Vessel>;
  name: string;
  summary: string | null;
  /** Sale listings only. Charter pricing lives in `charter.rates`. */
  price: { amount: string | null; currency: string | null; on_application: boolean; starting_price: boolean } | null;
  /** Every asking price the listing has had, in any order. */
  priceHistory: PriceHistoryEntry[];
  location: (Sparse<Location> & { display: string }) | null;
  brokers: (Sparse<Broker> & { name: string })[];
  specifications: Sparse<Omit<Specifications, "engines" | "generators" | "cabin_config" | "berth_config" | "crew_accommodation">> & {
    power_or_sail: "power" | "sail";
    engines?: Sparse<Engine>[];
    generators?: Sparse<Generator>[];
    cabin_config?: Sparse<CabinConfig> | null;
    berth_config?: Sparse<BerthConfig> | null;
    crew_accommodation?: Sparse<CrewAccommodation> | null;
  };
  descriptions: Description[];
  features: (Sparse<Feature> & { name: string })[];
  media: {
    profile?: (WithOriginal<Profile> & { thumbnail_url: string }) | null;
    gallery?: (WithOriginal<GalleryItem> & { sort: number })[];
    layouts?: (WithOriginal<LayoutItem> & { sort: number })[];
    videos?: (Sparse<VideoItem> & { url: string; sort: number })[];
    tours?: (Sparse<TourItem> & { url: string; sort: number })[];
    documents?: (Sparse<DocumentItem> & { url: string; sort: number })[];
  };
  charter: {
    rates?: (Sparse<Rate> & { season: string; rate_type: "weekly" | "daily" })[];
    operating_areas?: (Sparse<OperatingArea> & { name: string })[];
    summer_base_port?: string | null;
    winter_base_port?: string | null;
    crew?: (Sparse<CrewMember> & { role: string })[];
  } | null;
  usage: Sparse<Usage>;
  compliance: Sparse<Omit<Compliance, "classification">> & { classification?: (Sparse<ClassificationEntry> & { society: string })[] };
}

// ---------------------------------------------------------------------------
// Identity and lifecycle
// ---------------------------------------------------------------------------

/** The canonical URI: minted under this node's own domain only, and never changed (ID-1). */
export const canonicalUri = (domain: string, uuid: string) => `https://${domain}${API_BASE_PATH}/listings/${uuid}`;

/** draft → active ⇄ under_offer → sold | withdrawn. `sold` and `withdrawn` are terminal (ID-8). */
const TRANSITIONS: Record<ListingStatus, ListingStatus[]> = {
  draft: ["active", "withdrawn"],
  active: ["under_offer", "sold", "withdrawn"],
  under_offer: ["active", "sold", "withdrawn"],
  // A vessel that returns to the market gets a new listing with a new UUID.
  sold: [],
  withdrawn: [],
};

export const canTransition = (from: ListingStatus, to: ListingStatus) => TRANSITIONS[from].includes(to);
export const isTerminal = (status: ListingStatus) => status === "sold" || status === "withdrawn";

// ---------------------------------------------------------------------------
// Templates: every field of every block, at its "unknown" value
// ---------------------------------------------------------------------------

export const TEMPLATES = {
  vessel: {
    hin: null,
    imo: null,
    mmsi: null,
    official_number: null,
    builder: null,
    model: null,
    year_built: null,
    refit_year: null,
    loa_m: null,
    previous_names: [],
  } as Vessel,
  location: { display: "", city: null, state: null, country: null, marina: null, coordinates: null } as Location,
  broker: { name: "", title: null, email: null, phone: null, photo_url: null } as Broker,
  specifications: {
    beam_m: null,
    draft_max_m: null,
    draft_min_m: null,
    lwl_m: null,
    lod_m: null,
    bridge_clearance_m: null,
    gross_tonnage: null,
    displacement_kg: null,
    fuel_capacity_l: null,
    water_capacity_l: null,
    holding_tank_l: null,
    cruise_speed_kn: null,
    max_speed_kn: null,
    range_nmi: null,
    fuel_consumption_lph: null,
    hull_material: null,
    superstructure_material: null,
    deck_material: null,
    hull_shape: null,
    hull_color: null,
    naval_architect: null,
    exterior_designer: null,
    interior_designer: null,
    fuel_type: null,
    flag: null,
    registry_port: null,
    power_or_sail: "power",
    category: null,
    cabins: null,
    sleeps: null,
    heads: null,
    guests_cruising: null,
    guests_entertaining: null,
    cabin_config: null,
    berth_config: null,
    crew_accommodation: null,
    engines: [],
    generators: [],
    tenders: null,
  } as Specifications,
  cabin_config: { double: null, twin: null, triple: null, single: null, convertible: null } as CabinConfig,
  berth_config: { king: null, queen: null, double: null, twin: null, single: null, pullman: null, bunk: null } as BerthConfig,
  crew_accommodation: { cabins: null, berths: null, layout: null } as CrewAccommodation,
  engine: {
    make: null,
    model: null,
    year: null,
    type: null,
    drive_type: null,
    power_hp: null,
    power_kw: null,
    fuel_type: null,
    hours: null,
    hours_recorded_at: null,
    location: null,
  } as Engine,
  generator: { make: null, model: null, power_kw: null, hours: null, hours_recorded_at: null } as Generator,
  feature: { category: null, name: "", slug: null, quantity: null } as Feature,
  profile: { url: "", sha256: null, width: null, height: null, caption: null, thumbnail_url: "" } as Profile,
  gallery_item: { url: "", sha256: null, category: null, width: null, height: null, caption: null, sort: 0, thumbnail_url: null } as GalleryItem,
  layout_item: { url: "", sha256: null, width: null, height: null, caption: null, sort: 0, thumbnail_url: null } as LayoutItem,
  video_item: { url: "", sha256: null, caption: null, sort: 0 } as VideoItem,
  tour_item: { url: "", caption: null, sort: 0 } as TourItem,
  document_item: { url: "", sha256: null, caption: null, sort: 0 } as DocumentItem,
  rate: {
    season: "",
    rate_type: "weekly",
    amount_min: null,
    amount_max: null,
    currency: null,
    contract_terms: null,
    apa_percent: null,
    vat_percent: null,
    valid_from: null,
    valid_to: null,
  } as Rate,
  operating_area: { name: "", slug: null, season: null } as OperatingArea,
  crew_member: { role: "", name: null, nationality: null, bio: null, photo_url: null, tba: false } as CrewMember,
  // The protocol's defaults. `expires_with_listing: true` is the RECOMMENDED
  // value: all use of the data ends when the listing does.
  usage: {
    display: true,
    attribution_required: true,
    attribution_text: null,
    marketing_materials: true,
    ai_indexing: true,
    expires_with_listing: true,
  } as Usage,
  compliance: {
    not_for_sale_to_us_residents_in_us_waters: null,
    vat_status: null,
    ce_certified: null,
    mca_compliant: null,
    classification: [],
  } as Compliance,
  classification_entry: { society: "", notation: null, next_survey_due: null } as ClassificationEntry,
};

/** The template with the stored values laid over it — the template's keys, and no others. */
function complete<T extends object>(template: T, stored: Sparse<T> | null | undefined): T {
  const result = { ...template };
  if (stored === null || stored === undefined) return result;
  for (const key of Object.keys(template) as (keyof T)[]) {
    const value = stored[key];
    if (value !== undefined) result[key] = value as T[keyof T];
  }
  return result;
}

const completeAll = <T extends object>(template: T, stored: Sparse<T>[] | undefined): T[] => (stored ?? []).map((item) => complete(template, item));
const bySort = <T extends { sort: number }>(items: T[]) => [...items].sort((a, b) => a.sort - b.sort);

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** This node's identity domain. */
  domain: string;
  /** The field groups granted to the partner being served. Anything not granted is withheld. */
  grants: ReadonlySet<FieldGroup>;
}

export function serializeListing(listing: OwnListing, options: SerializeOptions): OpenYachtListing {
  if (listing.status === "draft") throw new ListingError("A draft listing is never distributed (LS-7).");
  const granted = (group: FieldGroup) => options.grants.has(group);

  const vessel = complete(TEMPLATES.vessel, listing.vessel);
  if (!granted("vessel_identifiers")) Object.assign(vessel, { hin: null, imo: null, mmsi: null, official_number: null });

  const location = listing.location === null ? null : complete(TEMPLATES.location, listing.location);
  if (location !== null && !granted("location_exact")) Object.assign(location, { marina: null, coordinates: null });

  const specifications = complete(TEMPLATES.specifications, listing.specifications as Sparse<Specifications>);
  specifications.engines = completeAll(TEMPLATES.engine, listing.specifications.engines);
  specifications.generators = completeAll(TEMPLATES.generator, listing.specifications.generators);
  specifications.cabin_config = listing.specifications.cabin_config ? complete(TEMPLATES.cabin_config, listing.specifications.cabin_config) : null;
  specifications.berth_config = listing.specifications.berth_config ? complete(TEMPLATES.berth_config, listing.specifications.berth_config) : null;
  specifications.crew_accommodation = listing.specifications.crew_accommodation
    ? complete(TEMPLATES.crew_accommodation, listing.specifications.crew_accommodation)
    : null;

  return {
    id: canonicalUri(options.domain, listing.uuid),
    type: listing.type,
    status: listing.status,
    updated_at: toWireTimestamp(listing.updatedAt),
    listed_at: listing.listedAt === null ? null : toWireTimestamp(listing.listedAt),
    condition: listing.condition,
    agreement: listing.agreement,
    vessel,
    listing: {
      name: listing.name,
      summary: listing.summary,
      price: serializePrice(listing, granted("pricing")),
      price_history: granted("history") ? serializePriceHistory(listing) : [],
      location,
      brokers: completeAll(TEMPLATES.broker, listing.brokers),
    },
    specifications,
    descriptions: listing.descriptions.map(({ section, content }) => ({ section, content })),
    features: completeAll(TEMPLATES.feature, listing.features),
    media: serializeMedia(listing.media, { original: granted("media_original"), documents: granted("documents") }),
    charter: listing.type === "charter" ? serializeCharter(listing.charter, granted("pricing")) : null,
    usage: complete(TEMPLATES.usage, listing.usage),
    compliance: {
      ...complete(TEMPLATES.compliance, listing.compliance as Sparse<Compliance>),
      classification: completeAll(TEMPLATES.classification_entry, listing.compliance.classification),
    },
  };
}

/**
 * What a partner receives for a listing it can no longer see. `status` is the
 * real terminal status when the listing ended, and `withdrawn` when it was
 * merely unshared — a partner must not be able to tell the two apart from
 * anything but what the authority chooses to say.
 */
export function serializeTombstone(domain: string, uuid: string, status: "sold" | "withdrawn", at: Date): OpenYachtTombstone {
  return { id: canonicalUri(domain, uuid), tombstone: true, status, updated_at: toWireTimestamp(at) };
}

function serializePrice(listing: OwnListing, pricingGranted: boolean): OpenYachtListing["listing"]["price"] {
  // LS-10: a charter listing carries no price object at all; its pricing is `charter.rates`.
  if (listing.type === "charter") return null;
  const price = listing.price ?? { amount: null, currency: null, on_application: true, starting_price: false };
  const hidden = price.on_application || !pricingGranted;
  return {
    amount: hidden ? null : price.amount,
    currency: hidden ? null : price.currency,
    on_application: price.on_application,
    starting_price: price.starting_price,
  };
}

/** LS-10: most recent first, and the first entry is the current price. */
function serializePriceHistory(listing: OwnListing): PriceHistoryEntry[] {
  if (listing.type === "charter") return [];
  const history = [...listing.priceHistory].sort((a, b) => b.changed_at.localeCompare(a.changed_at));
  const current = listing.price;
  const latest = history[0];
  if (
    current?.amount &&
    !current.on_application &&
    (latest === undefined || latest.amount !== current.amount || latest.currency !== current.currency)
  ) {
    throw new ListingError(`Listing ${listing.uuid}: the newest price-history entry does not match the current price (LS-10).`);
  }
  return history.map(({ amount, currency, changed_at }) => ({ amount, currency, changed_at }));
}

function serializeMedia(media: OwnListing["media"], granted: { original: boolean; documents: boolean }): Media {
  // `media_original` swaps in the hi-res file where one is held; without it the
  // URL, hash and dimensions all describe the derived rendition (LS-14).
  const pick = <T extends { url: string; sha256: string | null; width: number | null; height: number | null }>(
    template: T,
    item: WithOriginal<T>,
  ): T => {
    const completed = complete(template, item as Sparse<T>);
    return granted.original && item.original ? { ...completed, ...item.original } : completed;
  };
  // LS-8, the other half: imagery without a chosen profile image is not
  // served. Promoting the first gallery image here would be the guess the rule
  // exists to prevent — the authority chooses the hero shot, explicitly.
  if (!media.profile && (media.gallery?.length || media.layouts?.length)) {
    throw new ListingError("The listing has gallery or layout images and no profile image (LS-8).");
  }
  return {
    // LS-8: a listing with no imagery has `profile: null` — never a placeholder.
    profile: media.profile ? pick(TEMPLATES.profile, media.profile) : null,
    gallery: bySort((media.gallery ?? []).map((item) => pick(TEMPLATES.gallery_item, item))),
    layouts: bySort((media.layouts ?? []).map((item) => pick(TEMPLATES.layout_item, item))),
    videos: bySort(completeAll(TEMPLATES.video_item, media.videos)),
    tours: bySort(completeAll(TEMPLATES.tour_item, media.tours)),
    // A URL a partner may not use is worse than no entry: withheld means empty.
    documents: granted.documents ? bySort(completeAll(TEMPLATES.document_item, media.documents)) : [],
  };
}

function serializeCharter(charter: OwnListing["charter"], pricingGranted: boolean): Charter {
  return {
    rates: pricingGranted ? completeAll(TEMPLATES.rate, charter?.rates) : [],
    operating_areas: completeAll(TEMPLATES.operating_area, charter?.operating_areas),
    summer_base_port: charter?.summer_base_port ?? null,
    winter_base_port: charter?.winter_base_port ?? null,
    crew: completeAll(TEMPLATES.crew_member, charter?.crew),
  };
}
