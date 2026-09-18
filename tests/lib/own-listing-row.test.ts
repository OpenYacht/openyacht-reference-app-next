// From a database row to a schema-valid wire document.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { FIELD_GROUPS, serializeListing } from "@/federation";
import { toOwnListing, type ListingRow, type VesselRow } from "@/lib/listings/own-listing-row";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  const dir = join(process.cwd(), "protocol/schemas/v1");
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")));
});

// Rows as they come back from a freshly inserted listing: column defaults only.
const vessel: VesselRow = {
  hin: null,
  imo: null,
  mmsi: null,
  official_number: null,
  builder_name: "Maritimo",
  builder_slug: "maritimo",
  model_name: "M50",
  model_slug: null,
  year_built: 2016,
  refit_year: null,
  loa_m: "15.24",
  previous_names: [],
};
const row = (overrides: Partial<ListingRow> = {}): ListingRow => ({
  uuid: "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b",
  listing_type: "sale",
  status: "active",
  name: "TEST PATTERN",
  summary: null,
  condition: null,
  agreement_type: null,
  co_brokerage: null,
  price_amount: null,
  price_currency: null,
  price_on_application: false,
  price_starting: false,
  location_display: null,
  location_city: null,
  location_state: null,
  location_country: null,
  location_marina: null,
  location_lat: null,
  location_lon: null,
  brokers: [],
  specifications: { power_or_sail: "power" },
  descriptions: [],
  features: [],
  media: {},
  charter: null,
  usage: {},
  compliance: {},
  listed_at: "2026-09-18T20:40:00.123+00:00",
  federation_updated_at: "2026-09-18T20:41:07.456+00:00",
  ...overrides,
});

const serve = (listing: ListingRow, history: Parameters<typeof toOwnListing>[2] = []) =>
  serializeListing(toOwnListing(listing, vessel, history), { domain: "node.example", grants: new Set(FIELD_GROUPS) });

function expectValid(document: unknown) {
  const validate = ajv.getSchema("https://openyacht.org/schemas/v1/listing.schema.json")!;
  validate(document);
  expect(validate.errors ?? []).toEqual([]);
}

describe("a stored listing becomes a schema-valid wire document", () => {
  it("with nothing but the column defaults filled in", () => {
    const document = serve(row());
    expectValid(document);
    expect(document).toMatchObject({ updated_at: "2026-09-18T20:41:07Z", listed_at: "2026-09-18T20:40:00Z", agreement: null });
    expect(document.listing).toMatchObject({ location: null, price: { amount: null, currency: null, on_application: false, starting_price: false } });
  });

  it("LS-2: the vessel's length is a JSON number in metres, though Postgres returns numeric as a string", () => {
    expect(serve(row()).vessel).toMatchObject({ loa_m: 15.24, builder: { name: "Maritimo", slug: "maritimo" }, model: { name: "M50", slug: null } });
  });

  it("API-12: the price is served as the string that was stored, never a number", () => {
    const document = serve(row({ price_amount: "1388000.50", price_currency: "USD" }), [
      { amount: "1388000.50", currency: "USD", changed_at: "2026-09-18T20:40:00.999+00:00" },
    ]);
    expectValid(document);
    expect(document.listing.price).toMatchObject({ amount: "1388000.50", currency: "USD" });
    expect(document.listing.price_history).toEqual([{ amount: "1388000.50", currency: "USD", changed_at: "2026-09-18T20:40:00Z" }]);
  });

  it("a charter row serves `price: null` and a complete charter block", () => {
    const document = serve(row({ listing_type: "charter", charter: { summer_base_port: "Palma de Mallorca" } }));
    expectValid(document);
    expect(document.listing.price).toBeNull();
    expect(document.charter).toMatchObject({ summer_base_port: "Palma de Mallorca", rates: [], crew: [] });
  });

  it("location and coordinates", () => {
    const document = serve(row({ location_display: "Palma de Mallorca, Spain", location_country: "ES", location_lat: 39.57, location_lon: 2.65 }));
    expectValid(document);
    expect(document.listing.location).toEqual({
      display: "Palma de Mallorca, Spain",
      city: null,
      state: null,
      country: "ES",
      marina: null,
      coordinates: { lat: 39.57, lon: 2.65 },
    });
  });
});
