// Serialising this node's own listings: complete objects, field-group gating,
// price history, lifecycle — every emitted document validated against the
// published schemas.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalUri,
  canTransition,
  FIELD_GROUPS,
  ListingError,
  serializeListing,
  serializeTombstone,
  TEMPLATES,
  type FieldGroup,
  type ListingStatus,
  type OpenYachtListing,
  type OwnListing,
} from "@/federation";

const protocolDir = join(process.cwd(), "protocol");
const SCHEMA_BASE = "https://openyacht.org/schemas/v1/";
const DOMAIN = "authority.example";
const ALL = new Set<FieldGroup>(FIELD_GROUPS);
const NONE = new Set<FieldGroup>();

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  for (const file of readdirSync(join(protocolDir, "schemas/v1")))
    ajv.addSchema(JSON.parse(readFileSync(join(protocolDir, "schemas/v1", file), "utf8")));
});

function expectValid(schema: string, document: unknown) {
  const validate = ajv.getSchema(`${SCHEMA_BASE}${schema}.schema.json`)!;
  validate(document);
  expect(validate.errors ?? []).toEqual([]);
}

const example = (name: string) => JSON.parse(readFileSync(join(protocolDir, `examples/valid/${name}.json`), "utf8")) as OpenYachtListing;

/** Loads a wire document as the host would hold it. */
function stored(wire: OpenYachtListing, overrides: Partial<OwnListing> = {}): OwnListing {
  return {
    uuid: wire.id.slice(-36),
    type: wire.type,
    status: wire.status,
    updatedAt: new Date(wire.updated_at),
    listedAt: wire.listed_at === null ? null : new Date(wire.listed_at),
    condition: wire.condition,
    agreement: wire.agreement,
    vessel: wire.vessel,
    name: wire.listing.name,
    summary: wire.listing.summary,
    price: wire.listing.price,
    priceHistory: wire.listing.price_history,
    location: wire.listing.location,
    brokers: wire.listing.brokers,
    specifications: wire.specifications,
    descriptions: wire.descriptions,
    features: wire.features,
    media: wire.media,
    charter: wire.charter,
    usage: wire.usage,
    compliance: wire.compliance,
    ...overrides,
  };
}

/** The least a listing can be: a name, a type, and whether it is power or sail. */
const minimal = (type: "sale" | "charter"): OwnListing => ({
  uuid: "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b",
  type,
  status: "active",
  updatedAt: new Date("2026-09-18T12:00:00.123Z"),
  listedAt: null,
  condition: null,
  agreement: null,
  vessel: {},
  name: "TEST PATTERN",
  summary: null,
  price: null,
  priceHistory: [],
  location: null,
  brokers: [],
  specifications: { power_or_sail: "power" },
  descriptions: [],
  features: [],
  media: {},
  charter: null,
  usage: {},
  compliance: {},
});

describe("LS-1 complete objects", () => {
  it.each(["sale-full", "charter-full"])("round-trips the protocol's own %s example exactly", (name) => {
    const wire = example(name);
    const domain = new URL(wire.id).hostname;
    expect(serializeListing(stored(wire), { domain, grants: ALL })).toEqual(wire);
  });

  it.each(["sale", "charter"] as const)("the sparsest possible %s listing still emits every field, and is schema-valid", (type) => {
    const document = serializeListing(minimal(type), { domain: DOMAIN, grants: ALL });
    expectValid("listing", document);
    expect(document.vessel).toEqual(TEMPLATES.vessel);
    expect(document.media).toEqual({ profile: null, gallery: [], layouts: [], videos: [], tours: [], documents: [] });
    expect(document.updated_at).toBe("2026-09-18T12:00:00Z");
  });

  it("every template lists exactly the fields its schema definition does", () => {
    const definitions = JSON.parse(readFileSync(join(protocolDir, "schemas/v1/listing.schema.json"), "utf8")).$defs;
    for (const [name, template] of Object.entries(TEMPLATES)) {
      expect(Object.keys(template).sort(), name).toEqual(Object.keys(definitions[name].properties).sort());
    }
  });

  it("emits nothing the schema does not define, whatever is stored", () => {
    const listing = minimal("sale");
    Object.assign(listing.vessel, { internal_note: "owner is motivated", engine_serial: "X123" });
    Object.assign(listing.specifications, { cost_price: "1" });
    const document = serializeListing(listing, { domain: DOMAIN, grants: ALL });
    expectValid("listing", document);
    expect(JSON.stringify(document)).not.toMatch(/internal_note|engine_serial|cost_price/);
  });

  it("completes nested items: a sparsely stored engine, feature and broker", () => {
    const listing = minimal("sale");
    listing.specifications.engines = [{ make: "Volvo" }];
    listing.features = [{ name: "Seabob", quantity: 2 }];
    listing.brokers = [{ name: "Alex Marlow" }];
    const document = serializeListing(listing, { domain: DOMAIN, grants: ALL });
    expectValid("listing", document);
    expect(document.specifications.engines[0]).toEqual({ ...TEMPLATES.engine, make: "Volvo" });
    expect(document.features[0]).toEqual({ category: null, name: "Seabob", slug: null, quantity: 2 });
  });
});

describe("LS-14 field-group gating", () => {
  const sale = () => stored(example("sale-full"));
  const charter = () => stored(example("charter-full"));
  const serve = (listing: OwnListing, ...granted: FieldGroup[]) => serializeListing(listing, { domain: DOMAIN, grants: new Set(granted) });
  const allBut = (group: FieldGroup) => FIELD_GROUPS.filter((g) => g !== group);

  it("with nothing granted the document is still complete and schema-valid", () => {
    for (const listing of [sale(), charter()]) expectValid("listing", serve(listing));
  });

  it("pricing: withholds the amount and currency, and a charter's rates", () => {
    const document = serve(sale(), ...allBut("pricing"));
    expect(document.listing.price).toEqual({ amount: null, currency: null, on_application: false, starting_price: false });
    expect(serve(charter(), ...allBut("pricing")).charter!.rates).toEqual([]);
    expect(serve(charter(), "pricing").charter!.rates.length).toBeGreaterThan(0);
  });

  it("history: withholds the price history", () => {
    expect(serve(sale(), ...allBut("history")).listing.price_history).toEqual([]);
    expect(serve(sale(), "history").listing.price_history).toHaveLength(2);
  });

  it("location_exact: withholds the marina and coordinates, keeps the public wording", () => {
    const listing = sale();
    listing.location = { ...listing.location!, marina: "Berth 12, Example Marina", coordinates: { lat: 47.6, lon: -122.3 } };
    const withheld = serve(listing, ...allBut("location_exact")).listing.location!;
    expect(withheld).toMatchObject({ display: "Seattle, Washington, United States", marina: null, coordinates: null });
    expect(serve(listing, "location_exact").listing.location!.marina).toBe("Berth 12, Example Marina");
  });

  it("vessel_identifiers: withholds HIN, IMO, MMSI and official number", () => {
    expect(serve(sale(), ...allBut("vessel_identifiers")).vessel).toMatchObject({ hin: null, imo: null, mmsi: null, official_number: null });
    expect(serve(sale(), "vessel_identifiers").vessel.hin).toBe("OEOM5021G516");
  });

  it("documents: served as an empty array — a URL a partner may not use is worse than no entry", () => {
    const listing = sale();
    listing.media = {
      ...listing.media,
      documents: [{ url: "https://authority.example/media/brochure.pdf", sha256: null, caption: "Brochure", sort: 1 }],
    };
    expect(serve(listing, ...allBut("documents")).media.documents).toEqual([]);
    expect(serve(listing, "documents").media.documents).toHaveLength(1);
  });

  it("media_original: the hi-res file replaces the derived rendition only when granted — URL, hash and dimensions together", () => {
    const listing = sale();
    const original = { url: "https://authority.example/media/originals/profile.jpg", sha256: "a".repeat(64), width: 8000, height: 5333 };
    listing.media = { ...listing.media, profile: { ...listing.media.profile!, original } };
    const derived = serve(listing, ...allBut("media_original")).media.profile!;
    expect(derived).toMatchObject({ width: 4000, url: expect.stringContaining("/profile.jpg") });
    expect(JSON.stringify(derived)).not.toContain("originals");
    const granted = serve(listing, "media_original").media.profile!;
    expect(granted).toMatchObject(original);
    expectValid("listing", serve(listing, "media_original"));
  });
});

describe("LS-10 price and price history", () => {
  it("orders the history most recent first, whatever order it was stored in", () => {
    const listing = stored(example("sale-full"));
    listing.priceHistory = [...listing.priceHistory].reverse();
    const history = serializeListing(listing, { domain: DOMAIN, grants: ALL }).listing.price_history;
    expect(history.map((entry) => entry.amount)).toEqual(["1388000", "1450000"]);
    expect(history[0]).toMatchObject({ amount: listing.price!.amount, currency: listing.price!.currency });
  });

  it("refuses to serve a history whose newest entry is not the current price", () => {
    const listing = stored(example("sale-full"));
    listing.price = { ...listing.price!, amount: "1300000" };
    expect(() => serializeListing(listing, { domain: DOMAIN, grants: ALL })).toThrow(ListingError);
  });

  it("price on application: amount and currency are null even with pricing granted", () => {
    const listing = minimal("sale");
    listing.price = { amount: "5000000", currency: "EUR", on_application: true, starting_price: false };
    expect(serializeListing(listing, { domain: DOMAIN, grants: ALL }).listing.price).toEqual({
      amount: null,
      currency: null,
      on_application: true,
      starting_price: false,
    });
  });

  it("a charter listing carries `price: null`, no price history, and a complete charter block", () => {
    const document = serializeListing(minimal("charter"), { domain: DOMAIN, grants: ALL });
    expect(document.listing.price).toBeNull();
    expect(document.listing.price_history).toEqual([]);
    expect(document.charter).toEqual({ rates: [], operating_areas: [], summer_base_port: null, winter_base_port: null, crew: [] });
  });

  it("a sale listing carries `charter: null`", () => {
    expect(serializeListing(minimal("sale"), { domain: DOMAIN, grants: ALL }).charter).toBeNull();
  });
});

describe("LS-7 / LS-8", () => {
  it("LS-7: a draft is never serialised", () => {
    expect(() => serializeListing({ ...minimal("sale"), status: "draft" }, { domain: DOMAIN, grants: ALL })).toThrow(/draft/);
  });

  it("LS-8: a listing with no imagery has `profile: null` — no placeholder", () => {
    expect(serializeListing(minimal("sale"), { domain: DOMAIN, grants: ALL }).media.profile).toBeNull();
  });

  it("LS-8: imagery without a profile image is refused, not papered over with the first gallery image", () => {
    const listing = minimal("sale");
    listing.media = { profile: null, gallery: [{ url: "https://authority.example/media/01.jpg", sort: 1 }] };
    expect(() => serializeListing(listing, { domain: DOMAIN, grants: ALL })).toThrow(ListingError);
  });
});

describe("ID-1 canonical URIs and tombstones", () => {
  it("mints the URI under this node's own domain", () => {
    expect(canonicalUri(DOMAIN, "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b")).toBe(
      "https://authority.example/openyacht/v1/listings/018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b",
    );
  });

  it("the URI does not change when the listing does", () => {
    const listing = minimal("sale");
    const before = serializeListing(listing, { domain: DOMAIN, grants: ALL }).id;
    const after = serializeListing(
      { ...listing, name: "RENAMED", status: "under_offer", updatedAt: new Date() },
      { domain: DOMAIN, grants: NONE },
    ).id;
    expect(after).toBe(before);
  });

  it("a tombstone is schema-valid and carries the same URI", () => {
    const tombstone = serializeTombstone(DOMAIN, "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b", "sold", new Date("2026-09-18T20:16:02.500Z"));
    expectValid("tombstone", tombstone);
    expect(tombstone).toEqual({
      id: canonicalUri(DOMAIN, "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b"),
      tombstone: true,
      status: "sold",
      updated_at: "2026-09-18T20:16:02Z",
    });
  });
});

describe("ID-8 lifecycle", () => {
  const allowed: [ListingStatus, ListingStatus][] = [
    ["draft", "active"],
    ["draft", "withdrawn"],
    ["active", "under_offer"],
    ["under_offer", "active"],
    ["active", "sold"],
    ["active", "withdrawn"],
    ["under_offer", "sold"],
    ["under_offer", "withdrawn"],
  ];

  it("allows draft → active ⇄ under_offer → sold | withdrawn, and nothing else", () => {
    const statuses: ListingStatus[] = ["draft", "active", "under_offer", "sold", "withdrawn"];
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed.some(([a, b]) => a === from && b === to));
      }
    }
  });

  it("sold and withdrawn are terminal: a returning vessel gets a new listing", () => {
    for (const to of ["draft", "active", "under_offer", "sold", "withdrawn"] as const) {
      expect(canTransition("sold", to)).toBe(false);
      expect(canTransition("withdrawn", to)).toBe(false);
    }
  });
});
