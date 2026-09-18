import type { OwnListing } from "@/federation";

// A listing as the database holds it, and the mapping to what the federation
// core serialises. No "server-only" marker here: it is a pure function, and the
// unit lane runs it.

export interface VesselRow {
  hin: string | null;
  imo: string | null;
  mmsi: string | null;
  official_number: string | null;
  builder_name: string | null;
  builder_slug: string | null;
  model_name: string | null;
  model_slug: string | null;
  year_built: number | null;
  refit_year: number | null;
  /** `numeric` arrives from Postgres as a string. */
  loa_m: string | number | null;
  previous_names: string[];
}

export interface ListingRow {
  uuid: string;
  listing_type: "sale" | "charter";
  status: OwnListing["status"];
  name: string;
  summary: string | null;
  condition: OwnListing["condition"];
  agreement_type: "central" | "exclusive" | "open" | null;
  co_brokerage: boolean | null;
  price_amount: string | null;
  price_currency: string | null;
  price_on_application: boolean;
  price_starting: boolean;
  location_display: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  location_marina: string | null;
  location_lat: number | null;
  location_lon: number | null;
  brokers: OwnListing["brokers"];
  specifications: OwnListing["specifications"];
  descriptions: OwnListing["descriptions"];
  features: OwnListing["features"];
  media: OwnListing["media"];
  charter: OwnListing["charter"];
  usage: OwnListing["usage"];
  compliance: OwnListing["compliance"];
  listed_at: string | Date | null;
  federation_updated_at: string | Date;
}

export interface PriceHistoryRow {
  amount: string;
  currency: string;
  changed_at: string | Date;
}

const wireTimestamp = (value: string | Date) => `${new Date(value).toISOString().slice(0, 19)}Z`;
const vocab = (name: string | null, slug: string | null) => (name === null ? null : { name, slug });

export function toOwnListing(row: ListingRow, vessel: VesselRow, priceHistory: PriceHistoryRow[]): OwnListing {
  const hasAgreement = row.agreement_type !== null || row.co_brokerage !== null;
  return {
    uuid: row.uuid,
    type: row.listing_type,
    status: row.status,
    updatedAt: new Date(row.federation_updated_at),
    listedAt: row.listed_at === null ? null : new Date(row.listed_at),
    condition: row.condition,
    agreement: hasAgreement ? { type: row.agreement_type, co_brokerage: row.co_brokerage } : null,
    vessel: {
      hin: vessel.hin,
      imo: vessel.imo,
      mmsi: vessel.mmsi,
      official_number: vessel.official_number,
      builder: vocab(vessel.builder_name, vessel.builder_slug),
      model: vocab(vessel.model_name, vessel.model_slug),
      year_built: vessel.year_built,
      refit_year: vessel.refit_year,
      // Units are canonical metric and a JSON number on the wire (LS-2).
      loa_m: vessel.loa_m === null ? null : Number(vessel.loa_m),
      previous_names: vessel.previous_names,
    },
    name: row.name,
    summary: row.summary,
    price:
      row.listing_type === "charter"
        ? null
        : { amount: row.price_amount, currency: row.price_currency, on_application: row.price_on_application, starting_price: row.price_starting },
    priceHistory: priceHistory.map((entry) => ({ amount: entry.amount, currency: entry.currency, changed_at: wireTimestamp(entry.changed_at) })),
    location:
      row.location_display === null
        ? null
        : {
            display: row.location_display,
            city: row.location_city,
            state: row.location_state,
            country: row.location_country,
            marina: row.location_marina,
            coordinates: row.location_lat === null || row.location_lon === null ? null : { lat: row.location_lat, lon: row.location_lon },
          },
    brokers: row.brokers,
    specifications: row.specifications,
    descriptions: row.descriptions,
    features: row.features,
    media: row.media,
    charter: row.charter,
    usage: row.usage,
    compliance: row.compliance,
  };
}
