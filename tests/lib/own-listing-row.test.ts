// From a database row to a schema-valid wire document.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { FIELD_GROUPS, serializeListing } from "@/federation";
import { ListingError } from "@/federation";
import {
  originalPaths,
  storedFiles,
  toOwnListing,
  type ListingRow,
  type MediaUrls,
  type StoredImage,
  type VesselRow,
} from "@/lib/listings/own-listing-row";

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

// Paths become URLs when a listing is served. Originals get a URL only when
// one was minted for the request: here, always.
const urls: MediaUrls = {
  served: (path) => `https://files.example/public/${path}`,
  original: (path) => `https://files.example/signed/${path}?token=t`,
};

const serve = (listing: ListingRow, history: Parameters<typeof toOwnListing>[2] = [], grants: readonly string[] = FIELD_GROUPS, mediaUrls = urls) =>
  serializeListing(toOwnListing(listing, vessel, history, mediaUrls), { domain: "node.example", grants: new Set(grants) as never });

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
      { id: 1, amount: "1388000.50", currency: "USD", changed_at: "2026-09-18T20:40:00.999+00:00" },
    ]);
    expectValid(document);
    expect(document.listing.price).toMatchObject({ amount: "1388000.50", currency: "USD" });
    expect(document.listing.price_history).toEqual([{ amount: "1388000.50", currency: "USD", changed_at: "2026-09-18T20:40:00Z" }]);
  });

  it("LS-10: two price changes inside one second keep their order, though the wire timestamps tie", () => {
    // Given oldest-first, as an unordered query may return them.
    const history = [
      { id: 7, amount: "1250000", currency: "EUR", changed_at: "2026-09-18T21:58:24.554695+00:00" },
      { id: 8, amount: "1195000", currency: "EUR", changed_at: "2026-09-18T21:58:24.586721+00:00" },
    ];
    const document = serve(row({ price_amount: "1195000", price_currency: "EUR" }), history);
    expectValid(document);
    expect(document.listing.price_history).toEqual([
      { amount: "1195000", currency: "EUR", changed_at: "2026-09-18T21:58:24Z" },
      { amount: "1250000", currency: "EUR", changed_at: "2026-09-18T21:58:24Z" },
    ]);
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

describe("stored media becomes wire media", () => {
  const UUID = "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b";
  const image = (id: string, extra: Partial<StoredImage> = {}): StoredImage => ({
    id,
    path: `${UUID}/${id}/derived.jpg`,
    thumbnail_path: `${UUID}/${id}/thumbnail.jpg`,
    sha256: "d".repeat(64),
    width: 1920,
    height: 1280,
    original: { path: `${UUID}/${id}/original.jpg`, sha256: "0".repeat(64), width: 4000, height: 2667 },
    ...extra,
  });
  const media = {
    profile: image("hero", { caption: "At anchor" }),
    gallery: [image("b", { sort: 2, category: "interior" }), image("a", { sort: 1 })],
    layouts: [image("ga", { sort: 1, original: null })],
    videos: [{ id: "v", url: "https://video.example/watch/1", sort: 1 }],
    tours: [],
    documents: [{ id: "d", path: `${UUID}/d/brochure.pdf`, sha256: "b".repeat(64), caption: "Brochure", sort: 1 }],
  };

  it("is schema-valid, in sort order, and carries none of the node's bookkeeping", () => {
    const document = serve(row({ media }));
    expectValid(document);
    expect(document.media.gallery.map((item) => item.url)).toEqual([
      `https://files.example/signed/${UUID}/a/original.jpg?token=t`,
      `https://files.example/signed/${UUID}/b/original.jpg?token=t`,
    ]);
    expect(JSON.stringify(document.media)).not.toMatch(/"(id|path|thumbnail_path|original)"/);
    expect(document.media.videos).toEqual([{ url: "https://video.example/watch/1", sha256: null, caption: null, sort: 1 }]);
    expect(document.media.documents[0]).toEqual({
      url: `https://files.example/public/${UUID}/d/brochure.pdf`,
      sha256: "b".repeat(64),
      caption: "Brochure",
      sort: 1,
    });
  });

  it("LS-14: with media_original, the URL, hash and dimensions are the original's; without it, the derived rendition's", () => {
    const granted = serve(row({ media })).media.profile!;
    expect(granted).toMatchObject({
      url: `https://files.example/signed/${UUID}/hero/original.jpg?token=t`,
      sha256: "0".repeat(64),
      width: 4000,
      height: 2667,
    });

    const withheld = serve(
      row({ media }),
      [],
      FIELD_GROUPS.filter((group) => group !== "media_original"),
    ).media.profile!;
    expect(withheld).toMatchObject({
      url: `https://files.example/public/${UUID}/hero/derived.jpg`,
      sha256: "d".repeat(64),
      width: 1920,
      height: 1280,
    });
  });

  it("LS-8 / LS-16: the thumbnail is always present on the profile, and always a rendition of the same image", () => {
    const { profile, gallery } = serve(row({ media })).media;
    expect(profile!.thumbnail_url).toBe(`https://files.example/public/${UUID}/hero/thumbnail.jpg`);
    expect(gallery[0]!.thumbnail_url).toBe(`https://files.example/public/${UUID}/a/thumbnail.jpg`);
  });

  it("falls back to the derived rendition — hash and all — when no URL was minted for an original", () => {
    const profile = serve(row({ media }), [], FIELD_GROUPS, { ...urls, original: () => null }).media.profile!;
    expect(profile).toMatchObject({ url: `https://files.example/public/${UUID}/hero/derived.jpg`, sha256: "d".repeat(64), width: 1920 });
  });

  it("LS-8: imagery with no profile image is not served — no first-gallery-image guess", () => {
    expect(() => serve(row({ media: { ...media, profile: null } }))).toThrow(ListingError);
    expectValid(serve(row({ media: { videos: media.videos } })));
  });

  it("lists the files behind a media block, by bucket", () => {
    expect(originalPaths(media)).toEqual([`${UUID}/hero/original.jpg`, `${UUID}/b/original.jpg`, `${UUID}/a/original.jpg`]);
    const files = storedFiles(media);
    expect(files.originals).toHaveLength(3);
    expect(files.served).toHaveLength(9);
    expect(files.served).toContain(`${UUID}/d/brochure.pdf`);
    expect(storedFiles({})).toEqual({ served: [], originals: [] });
  });
});
