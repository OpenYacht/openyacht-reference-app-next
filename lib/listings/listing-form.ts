import type { HtmlSanitiser } from "@/federation";

// Turning a submitted listing form into rows. A pure function — no database,
// no framework — so the data-entry rules are tested directly:
//   * a builder or category slug is only ever taken from the vendored registry
//     (LS-11); a builder that is not listed is kept by name with no slug, never
//     given an improvised one;
//   * money is a string of decimal digits, stored as typed (API-12);
//   * units are metric numbers (LS-2);
//   * markup is allowed in descriptions only, and is reduced to the restricted
//     subset when saved (LS-4).

export interface Choice {
  slug: string;
  name: string;
}

export interface ListingFormDeps {
  builders: Choice[];
  categories: Choice[];
  sanitiser: HtmlSanitiser;
}

export interface VesselValues {
  hin: string | null;
  imo: string | null;
  builder_name: string | null;
  builder_slug: string | null;
  model_name: string | null;
  year_built: number | null;
  loa_m: number | null;
}

export interface ListingValues {
  name: string;
  summary: string | null;
  condition: "new" | "used" | null;
  price_amount: string | null;
  price_currency: string | null;
  price_on_application: boolean;
  location_display: string | null;
  location_city: string | null;
  location_country: string | null;
  location_marina: string | null;
  /** Laid over the stored blocks, so fields this form does not edit survive a save. */
  specifications: Record<string, unknown>;
  overview: string | null;
  broker: { name: string; email: string | null; phone: string | null } | null;
  charter: Record<string, unknown> | null;
}

export type ParsedListingForm =
  { ok: true; listingType: "sale" | "charter"; vessel: VesselValues; listing: ListingValues } | { ok: false; errors: string[] };

const MONEY = /^[0-9]+(\.[0-9]+)?$/;

export function parseListingForm(form: FormData, deps: ListingFormDeps): ParsedListingForm {
  const errors: string[] = [];
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const number = (name: string, label: string, options: { integer?: boolean; min?: number; max?: number } = {}) => {
    const raw = text(name);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value)) || value < (options.min ?? 0) || value > (options.max ?? Infinity)) {
      errors.push(`${label} is not a valid number.`);
      return null;
    }
    return value;
  };
  const money = (name: string, label: string) => {
    const raw = text(name);
    if (raw !== null && !MONEY.test(raw)) {
      errors.push(`${label} must be digits only, with an optional decimal point — 1250000 or 1250000.50, no separators or symbols.`);
      return null;
    }
    return raw;
  };
  const currency = (name: string, label: string) => {
    const raw = text(name)?.toUpperCase() ?? null;
    if (raw !== null && !/^[A-Z]{3}$/.test(raw)) {
      errors.push(`${label} must be a three-letter ISO 4217 code, such as EUR.`);
      return null;
    }
    return raw;
  };

  const listingType = form.get("listing_type") === "charter" ? "charter" : "sale";
  const name = text("name");
  if (name === null) errors.push("The listing needs a name.");

  // The builder field offers the registry; whatever exactly matches a registry
  // name gets that entry's slug. Anything else is an unlisted builder.
  const builderInput = text("builder");
  const builder = builderInput === null ? null : (deps.builders.find((choice) => choice.name.toLowerCase() === builderInput.toLowerCase()) ?? null);

  const categorySlug = text("category");
  const category = categorySlug === null ? null : (deps.categories.find((choice) => choice.slug === categorySlug) ?? null);
  if (categorySlug !== null && category === null) errors.push("That category is not in the registry.");

  const powerOrSail = form.get("power_or_sail") === "sail" ? "sail" : "power";
  const onApplication = form.get("price_on_application") === "yes";
  const amount = listingType === "sale" ? money("price_amount", "The price") : null;
  const priceCurrency = listingType === "sale" ? currency("price_currency", "The currency") : null;
  if ((amount === null) !== (priceCurrency === null)) errors.push("A price needs both an amount and a currency.");

  const country = text("location_country")?.toUpperCase() ?? null;
  if (country !== null && !/^[A-Z]{2}$/.test(country)) errors.push("The country must be a two-letter ISO 3166 code, such as ES.");
  const locationDisplay = text("location_display");
  if (locationDisplay === null && (text("location_city") !== null || country !== null || text("location_marina") !== null)) {
    errors.push("A location needs its public wording — the text partners display.");
  }

  const overviewInput = text("overview");
  const brokerName = text("broker_name");
  if (brokerName === null && (text("broker_email") !== null || text("broker_phone") !== null)) errors.push("A broker needs a name.");

  let charter: Record<string, unknown> | null = null;
  if (listingType === "charter") {
    const rateMin = money("rate_min", "The lowest weekly rate");
    const rateMax = money("rate_max", "The highest weekly rate");
    const rateCurrency = currency("rate_currency", "The rate currency");
    if ((rateMin !== null || rateMax !== null) && rateCurrency === null) errors.push("Charter rates need a currency.");
    charter = {
      summer_base_port: text("summer_base_port"),
      winter_base_port: text("winter_base_port"),
      // A single fixed rate is min = max.
      rates:
        rateMin === null && rateMax === null
          ? []
          : [{ season: "summer", rate_type: "weekly", amount_min: rateMin ?? rateMax, amount_max: rateMax ?? rateMin, currency: rateCurrency }],
    };
  }

  const vessel: VesselValues = {
    hin: text("hin"),
    imo: text("imo"),
    builder_name: builder?.name ?? builderInput,
    builder_slug: builder?.slug ?? null,
    model_name: text("model"),
    year_built: number("year_built", "The year built", { integer: true, min: 1800, max: 2200 }),
    loa_m: number("loa_m", "The length overall", { min: 0.1, max: 1000 }),
  };

  // Every field is parsed before the errors are counted: a value parsed inside
  // the result below would report its problem after the decision had been made.
  const specifications = {
    power_or_sail: powerOrSail,
    category: category === null ? null : { name: category.name, slug: category.slug },
    beam_m: number("beam_m", "The beam", { min: 0.1, max: 200 }),
    cabins: number("cabins", "Cabins", { integer: true, max: 200 }),
    sleeps: number("sleeps", "Sleeps", { integer: true, max: 1000 }),
  };

  if (errors.length > 0 || name === null) return { ok: false, errors };
  return {
    ok: true,
    listingType,
    vessel,
    listing: {
      name,
      summary: text("summary"),
      condition: form.get("condition") === "new" ? "new" : form.get("condition") === "used" ? "used" : null,
      price_amount: amount,
      price_currency: priceCurrency,
      price_on_application: onApplication,
      location_display: locationDisplay,
      location_city: text("location_city"),
      location_country: country,
      location_marina: text("location_marina"),
      specifications,
      overview: overviewInput === null ? null : deps.sanitiser.sanitise(overviewInput),
      broker: brokerName === null ? null : { name: brokerName, email: text("broker_email"), phone: text("broker_phone") },
      charter,
    },
  };
}

/** The stored descriptions with the `overview` section replaced (or removed), and every other section kept. */
export function withOverview(descriptions: { section: string; content: string }[], overview: string | null) {
  const others = descriptions.filter((description) => description.section !== "overview");
  return overview === null || overview === "" ? others : [{ section: "overview", content: overview }, ...others];
}
