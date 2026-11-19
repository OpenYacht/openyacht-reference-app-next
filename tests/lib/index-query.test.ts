// The query string of the listing index pages: tabs, filters and paging.
import { describe, expect, it } from "vitest";
import {
  containsPattern,
  indexHref,
  OWN_LISTING_VIEWS,
  PAGE_SIZE,
  pageRange,
  parseIndexQuery,
  PARTNER_LISTING_VIEWS,
} from "@/lib/listings/index-query";

describe("ID-8 listing index tabs follow the lifecycle", () => {
  it("splits own listings into live, drafts and past, covering every status once", () => {
    const statuses = OWN_LISTING_VIEWS.flatMap((view) => [...view.statuses]);
    expect(statuses.sort()).toEqual(["active", "draft", "sold", "under_offer", "withdrawn"]);
  });

  it("splits partner listings into live and past; a copy is never a draft", () => {
    expect(PARTNER_LISTING_VIEWS.map((view) => view.key)).toEqual(["live", "past"]);
    expect(PARTNER_LISTING_VIEWS.flatMap((view) => [...view.statuses]).sort()).toEqual(["active", "sold", "under_offer", "withdrawn"]);
  });
});

describe("parseIndexQuery", () => {
  it("opens on the first tab with no filters", () => {
    expect(parseIndexQuery({}, OWN_LISTING_VIEWS)).toEqual({ view: "live", type: null, status: null, partner: null, q: "", page: 1 });
  });

  it("reads every filter", () => {
    expect(
      parseIndexQuery({ view: "past", type: "charter", status: "sold", partner: "56", q: "  Weather helm ", page: "3" }, OWN_LISTING_VIEWS),
    ).toEqual({
      view: "past",
      type: "charter",
      status: "sold",
      partner: "56",
      q: "Weather helm",
      page: 3,
    });
  });

  it("drops a status that belongs to another tab rather than filtering to nothing", () => {
    expect(parseIndexQuery({ view: "live", status: "sold" }, OWN_LISTING_VIEWS).status).toBeNull();
  });

  it("falls back on unknown or malformed values", () => {
    const query = parseIndexQuery({ view: "drafts", type: "lease", partner: "0x1", page: "-2", q: ["a", "b"] }, PARTNER_LISTING_VIEWS);
    expect(query).toEqual({ view: "live", type: null, status: null, partner: null, q: "", page: 1 });
  });

  it("caps the search at 100 characters", () => {
    expect(parseIndexQuery({ q: "x".repeat(500) }, OWN_LISTING_VIEWS).q).toHaveLength(100);
  });
});

describe("indexHref", () => {
  const query = parseIndexQuery({ view: "live", type: "sale", q: "helm", page: "4" }, OWN_LISTING_VIEWS);

  it("returns to page one on any change but the page", () => {
    expect(indexHref("/listings", query, { view: "past", status: null })).toBe("/listings?view=past&type=sale&q=helm");
  });

  it("keeps the filters when paging", () => {
    expect(indexHref("/listings", query, { page: 5 })).toBe("/listings?view=live&type=sale&q=helm&page=5");
  });

  it("encodes the search", () => {
    expect(indexHref("/copies", query, { q: "a&b=c" })).toBe("/copies?view=live&type=sale&q=a%26b%3Dc");
  });
});

describe("containsPattern", () => {
  it("quotes the value and wraps it in PostgREST wildcards", () => {
    expect(containsPattern("Helm")).toBe('"*Helm*"');
  });

  it("keeps commas and parentheses inside the quoted value", () => {
    expect(containsPattern("a,b),name.eq.x")).toBe('"*a,b),name.eq.x*"');
  });

  it("matches LIKE wildcards and backslashes literally", () => {
    // LIKE sees \% \_ \\, and each backslash is doubled again for the quoted value.
    expect(containsPattern("50%_\\")).toBe('"*50\\\\%\\\\_\\\\\\\\*"');
  });

  it("escapes double quotes and drops PostgREST's own wildcard", () => {
    expect(containsPattern('say "hi"*')).toBe('"*say \\"hi\\"*"');
  });
});

describe("pageRange", () => {
  it("gives the inclusive row range of a page", () => {
    expect(pageRange(1)).toEqual([0, PAGE_SIZE - 1]);
    expect(pageRange(3)).toEqual([2 * PAGE_SIZE, 3 * PAGE_SIZE - 1]);
  });
});
