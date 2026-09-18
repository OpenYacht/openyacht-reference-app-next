// Partner operations an administrator performs. Spec: federation-protocol.md
// §Partner Lifecycle, §Identity and Trust Model (FP-11, FP-12, FP-13, FP-16).
import { isValidDomain } from "./identity";
import {
  systemClock,
  type AcceptancePolicy,
  type Clock,
  type Partner,
  type PartnerRepository,
  type PublishedKey,
  type WellKnownSource,
} from "./ports";
import type { SignedClient } from "./signed-client";
import { API_BASE_PATH } from "./well-known";

export class PartnerError extends Error {}

/**
 * How the partner answered our introduction.
 *   delivered — registered over there, waiting on their administrator;
 *   accepted  — they already trust this node;
 *   blocked   — they have blocked this node;
 *   failed    — it did not arrive. The partner record is kept either way.
 */
export type IntroductionOutcome = { result: "delivered" | "accepted" | "blocked" } | { result: "failed"; reason: string };

export interface PartnerServiceOptions {
  ownDomain: string;
  partners: PartnerRepository;
  wellKnown: WellKnownSource;
  client: SignedClient;
  clock?: Clock;
}

export class PartnerService {
  private readonly clock: Clock;

  constructor(private readonly options: PartnerServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Adds a partner by domain: fetch its discovery document over verified TLS
   * and trust what it serves (trust on first use).
   *
   * Nothing but the domain is consulted. Where the domain was found — typed
   * in, or picked from the node directory — changes nothing: a directory entry
   * is never evidence of anything (FP-16).
   */
  async add(domainInput: string, options: { pinKey: boolean; acceptancePolicy: AcceptancePolicy }): Promise<Partner> {
    const domain = domainInput.trim().toLowerCase();
    if (!isValidDomain(domain)) throw new PartnerError(`"${domainInput}" is not a bare hostname.`);
    // A node that partners with itself signs requests to itself, verifies them
    // against its own key, and stores its own listings as a partner's copies.
    if (domain === this.options.ownDomain) throw new PartnerError("This is the node's own domain.");
    if ((await this.options.partners.findByDomain(domain)) !== null) throw new PartnerError(`${domain} is already a partner.`);

    const discovered = await this.options.wellKnown.fetchFresh(domain);
    return this.options.partners.create({
      domain,
      nodeUuid: discovered.nodeUuid,
      nodeName: discovered.name,
      // An administrator of this node chose to add the partner: that is the
      // human approval `verified` stands for. (A domain that contacts us
      // unprompted starts `provisional` instead — FP-13.)
      trustLevel: "verified",
      keys: discovered.keys,
      pinnedKeyId: options.pinKey ? currentSigningKeyId(discovered.keys) : null,
      acceptancePolicy: options.acceptancePolicy,
    });
  }

  /**
   * Re-reads the partner's discovery document on an administrator's request.
   *
   * With `confirmPin`, this action *is* the administrator confirmation FP-12
   * requires before a pinned partner's new key is accepted: the pin moves to
   * the partner's current signing key. Without such an action a pinned partner
   * that rotates its key is rejected forever — the verifier's own refetch
   * refreshes the cached keys but, correctly, never touches the pin.
   *
   * A changed node UUID wins over everything (FP-11): a different installation
   * behind the domain inherits neither the approval nor the pin.
   */
  async refreshKeys(partner: Partner, options: { confirmPin: boolean }): Promise<"refreshed" | "repinned" | "uuid_changed"> {
    const discovered = await this.options.wellKnown.fetchFresh(partner.domain);
    if (discovered.nodeUuid !== partner.nodeUuid) {
      await this.options.partners.recordUuidChange(partner.id, discovered.nodeUuid);
      return "uuid_changed";
    }
    await this.options.partners.updateDiscovery(partner.id, { nodeName: discovered.name, keys: discovered.keys });
    if (!options.confirmPin) return "refreshed";
    await this.options.partners.setPinnedKey(partner.id, currentSigningKeyId(discovered.keys));
    return "repinned";
  }

  /**
   * Lifecycle step 1: introduce this node with a signed partnership request,
   * so the partner's administrator learns who is asking and why *before*
   * approving — rather than noticing a stranger polling them.
   *
   * Both body fields are always sent. The prose spec does not say which are
   * required, the OpenAPI document requires both, and deployed receivers
   * differ; sending both satisfies every reading.
   */
  async introduce(partner: Partner, request: { message: string; contactEmail: string }): Promise<IntroductionOutcome> {
    let outcome: IntroductionOutcome;
    try {
      let response = await this.options.client.post(partner.domain, `${API_BASE_PATH}/partners/request`, {
        message: request.message,
        contact_email: request.contactEmail,
      });
      let viaProbe = false;
      if (response.status === 404 || response.status === 405) {
        // A node without this endpoint answers 404 from its router, before any
        // signature is read — so nothing registers us there. A signed listings
        // request is authenticated on every conforming node and does.
        response = await this.options.client.get(partner.domain, `${API_BASE_PATH}/listings?page_size=1`);
        viaProbe = true;
      }

      const trustLevel = isRecord(response.json) ? response.json.trust_level : null;
      if (response.status >= 200 && response.status < 300) {
        // Listings are served to verified partners only (FP-13), so a node
        // that answers the probe with a page has already approved us.
        outcome = { result: viaProbe || trustLevel === "verified" ? "accepted" : "delivered" };
      } else if (response.status === 403 && response.errorCode === "PARTNER_PROVISIONAL") {
        outcome = { result: "delivered" };
      } else if (response.status === 403 && response.errorCode === "PARTNER_BLOCKED") {
        outcome = { result: "blocked" };
      } else {
        outcome = { result: "failed", reason: `${partner.domain} answered ${response.status}${response.errorCode ? ` ${response.errorCode}` : ""}.` };
      }
    } catch (error) {
      outcome = { result: "failed", reason: error instanceof Error ? error.message : String(error) };
    }

    if (outcome.result === "delivered" || outcome.result === "accepted") {
      await this.options.partners.markRequestSent(partner.id, this.clock.now());
    }
    return outcome;
  }

  /**
   * Undoes a mistaken add. Allowed only while nothing has been received from
   * the partner: the partner record is the provenance anchor of every copy
   * (ID-3), so once listings have arrived a partnership ends by blocking.
   */
  async remove(partner: Partner): Promise<void> {
    if ((await this.options.partners.countCopies(partner.id)) > 0) {
      throw new PartnerError("Listings have been received from this partner. Block it instead.");
    }
    await this.options.partners.delete(partner.id);
  }
}

/** By convention a node lists its current signing key first. */
export function currentSigningKeyId(keys: PublishedKey[]): string {
  const current = keys[0];
  if (current === undefined) throw new PartnerError("The partner publishes no usable key.");
  return current.keyId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
