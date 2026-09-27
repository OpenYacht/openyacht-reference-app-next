// The consumer's local display rules: acceptance policy, group policies and
// import types. Spec: api-design.md §Implementation Notes (the policy is the
// partner's); none of it is on the wire.
import { describe, expect, it } from "vitest";
import { decideDisplay, effectiveAcceptancePolicy, type DisplayRules } from "@/federation";

const complete = {
  usage: { display: true },
  price: { amount: 1_250_000, currency: "EUR" },
  media: [{ category: "profile", thumbnail: { url: "https://authority.example/t.jpg" } }],
};
const rules = (overrides: Partial<DisplayRules> = {}): DisplayRules => ({
  acceptancePolicy: "hold",
  groupAcceptancePolicies: [],
  importTypes: "both",
  ...overrides,
});

describe("group acceptance policies", () => {
  it("raise a partner's own policy to the most permissive, and never lower it", () => {
    expect(effectiveAcceptancePolicy(rules())).toBe("hold");
    expect(effectiveAcceptancePolicy(rules({ groupAcceptancePolicies: ["accept_matching"] }))).toBe("accept_matching");
    expect(effectiveAcceptancePolicy(rules({ groupAcceptancePolicies: ["hold", "accept_all", "accept_matching"] }))).toBe("accept_all");
    expect(effectiveAcceptancePolicy(rules({ acceptancePolicy: "accept_all", groupAcceptancePolicies: ["hold"] }))).toBe("accept_all");
  });

  it("decide display through the effective policy", () => {
    expect(decideDisplay(complete, "sale", rules()).displayState).toBe("held");
    expect(decideDisplay(complete, "sale", rules({ groupAcceptancePolicies: ["accept_all"] })).displayState).toBe("published");
  });
});

describe("import types", () => {
  it("hold the excluded type whatever the policy, and say why", () => {
    const decision = decideDisplay(complete, "charter", rules({ acceptancePolicy: "accept_all", importTypes: "sale" }));
    expect(decision).toEqual({ displayState: "held", heldReasons: ["This partner's charter listings are not displayed here."] });
    expect(decideDisplay(complete, "sale", rules({ acceptancePolicy: "accept_all", importTypes: "sale" })).displayState).toBe("published");
  });

  it("ID-10: never display what the usage terms forbid, whatever the rules", () => {
    const forbidden = { ...complete, usage: { display: false } };
    expect(decideDisplay(forbidden, "sale", rules({ acceptancePolicy: "accept_all", groupAcceptancePolicies: ["accept_all"] })).displayState).toBe(
      "held",
    );
  });
});
