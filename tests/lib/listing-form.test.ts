// Data-entry rules for a listing, tested on the pure form parser.
import { describe, expect, it } from "vitest";
import { descriptionSanitiser } from "@/lib/federation/sanitiser";
import { parseListingForm, withOverview } from "@/lib/listings/listing-form";

const deps = {
  builders: [
    { slug: "maritimo", name: "Maritimo" },
    { slug: "benetti", name: "Benetti" },
  ],
  categories: [{ slug: "motor-yacht", name: "Motor Yacht" }],
  sanitiser: descriptionSanitiser,
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ listing_type: "sale", name: "WEATHER HELM", power_or_sail: "power", ...values })) data.set(key, value);
  return data;
}

const parse = (values: Record<string, string> = {}) => parseListingForm(form(values), deps);
const parsed = (values: Record<string, string> = {}) => {
  const result = parse(values);
  if (!result.ok) throw new Error(result.errors.join(" "));
  return result;
};
const errorsOf = (values: Record<string, string>) => {
  const result = parse(values);
  return result.ok ? [] : result.errors;
};

describe("LS-11 builder and category slugs come from the registry, never from typing", () => {
  it("a registry builder gets the registry's slug and canonical name, however it was typed", () => {
    expect(parsed({ builder: "  maritimo " }).vessel).toMatchObject({ builder_name: "Maritimo", builder_slug: "maritimo" });
  });

  it("an unlisted builder is kept by name with no slug — no slug is improvised", () => {
    expect(parsed({ builder: "Newyard Custom" }).vessel).toMatchObject({ builder_name: "Newyard Custom", builder_slug: null });
  });

  it("a category must be a registry entry", () => {
    expect(parsed({ category: "motor-yacht" }).listing.specifications.category).toEqual({ name: "Motor Yacht", slug: "motor-yacht" });
    expect(errorsOf({ category: "mega-yacht" })).toEqual(["That category is not in the registry."]);
    expect(parsed({}).listing.specifications.category).toBeNull();
  });
});

describe("API-12 money is a string of decimal digits", () => {
  it("is kept exactly as typed", () => {
    expect(parsed({ price_amount: "1250000.50", price_currency: "eur" }).listing).toMatchObject({
      price_amount: "1250000.50",
      price_currency: "EUR",
    });
  });

  it.each(["1,250,000", "€1250000", "1.25e6", "1250000.", "-1"])("refuses %s", (amount) => {
    expect(errorsOf({ price_amount: amount, price_currency: "EUR" }).join(" ")).toMatch(/digits only/);
  });

  it("needs an amount and a currency together, and a real currency code", () => {
    expect(errorsOf({ price_amount: "100" })).toContain("A price needs both an amount and a currency.");
    expect(errorsOf({ price_amount: "100", price_currency: "euros" }).join(" ")).toMatch(/three-letter/);
  });

  it("LS-10: a charter listing has no price; its pricing is a rate", () => {
    const result = parsed({
      listing_type: "charter",
      price_amount: "999",
      price_currency: "EUR",
      rate_min: "28000",
      rate_max: "32000",
      rate_currency: "EUR",
    });
    expect(result.listing).toMatchObject({ price_amount: null, price_currency: null });
    expect(result.listing.charter).toMatchObject({
      rates: [{ season: "summer", rate_type: "weekly", amount_min: "28000", amount_max: "32000", currency: "EUR" }],
    });
  });

  it("a single fixed charter rate is min = max", () => {
    const rates = parsed({ listing_type: "charter", rate_min: "30000", rate_currency: "EUR" }).listing.charter!.rates as {
      amount_min: string;
      amount_max: string;
    }[];
    expect(rates[0]).toMatchObject({ amount_min: "30000", amount_max: "30000" });
  });

  it("a sale listing has no charter block", () => {
    expect(parsed({}).listing.charter).toBeNull();
  });
});

describe("LS-2 metric numbers", () => {
  it("parses lengths and counts as numbers", () => {
    const result = parsed({ loa_m: "15.24", beam_m: "5.05", cabins: "2", year_built: "2019" });
    expect(result.vessel).toMatchObject({ loa_m: 15.24, year_built: 2019 });
    expect(result.listing.specifications).toMatchObject({ beam_m: 5.05, cabins: 2 });
  });

  it.each([
    ["loa_m", "50 ft"],
    ["year_built", "19"],
    ["cabins", "2.5"],
  ])("refuses %s = %s", (field, value) => {
    expect(errorsOf({ [field]: value }).join(" ")).toMatch(/not a valid number/);
  });
});

describe("LS-4 markup is reduced to the allowed subset when saved", () => {
  it("sanitises the overview", () => {
    expect(parsed({ overview: '<p>Lovely.</p><script>alert(1)</script><img src="x">' }).listing.overview).toBe("<p>Lovely.</p>");
  });

  it("replaces only the overview section and keeps the others", () => {
    const stored = [
      { section: "overview", content: "<p>old</p>" },
      { section: "Notable Upgrades", content: "<p>kept</p>" },
    ];
    expect(withOverview(stored, "<p>new</p>")).toEqual([
      { section: "overview", content: "<p>new</p>" },
      { section: "Notable Upgrades", content: "<p>kept</p>" },
    ]);
    expect(withOverview(stored, null)).toEqual([{ section: "Notable Upgrades", content: "<p>kept</p>" }]);
  });
});

describe("the rest of the form", () => {
  it("needs a name", () => {
    expect(errorsOf({ name: "  " })).toContain("The listing needs a name.");
  });

  it("a location needs its public wording, and a two-letter country", () => {
    expect(errorsOf({ location_city: "Palma" }).join(" ")).toMatch(/public wording/);
    expect(errorsOf({ location_display: "Palma, Spain", location_country: "Spain" }).join(" ")).toMatch(/two-letter/);
    expect(parsed({ location_display: "Palma, Spain", location_country: "es" }).listing.location_country).toBe("ES");
  });

  it("reports every problem at once", () => {
    expect(errorsOf({ name: "", price_amount: "1,000", location_country: "Spain", location_display: "x" }).length).toBeGreaterThanOrEqual(3);
  });

  it("blank fields are null, never empty strings", () => {
    const result = parsed({ summary: "  ", hin: "" });
    expect(result.listing.summary).toBeNull();
    expect(result.vessel.hin).toBeNull();
  });
});
