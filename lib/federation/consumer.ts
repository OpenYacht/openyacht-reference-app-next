import "server-only";
import {
  decideDisplay,
  GuardedHttpsClient,
  isSyncDue,
  parseNodeIdentity,
  PartnerService,
  SignedClient,
  Signer,
  SyncEngine,
  WellKnownClient,
  type Partner,
  type PartnerRepository,
  type SyncOutcome,
} from "@/federation";
import { serviceClient } from "@/lib/supabase/service";
import { vendoredRegistry } from "./registry";
import { SupabaseCopyRepository, SupabasePartnerRepository } from "./repositories";
import { descriptionSanitiser } from "./sanitiser";
import { SOFTWARE } from "./software";

// The federation core bound to this application: real HTTPS, the Vault-held
// signing key, and the Supabase repositories.

const http = new GuardedHttpsClient(SOFTWARE);
// One instance per process: it holds the per-domain refetch rate limit. Shared
// with inbound verification, so both directions respect the same limit.
export const wellKnown = new WellKnownClient(http);

/**
 * The current signer. The private seed is read from Vault when a request is
 * about to be signed and is not kept between calls.
 */
async function currentSigner(): Promise<Signer> {
  const { data, error } = await serviceClient().rpc("active_signing_key").single<{ key_id: string; private_key: string }>();
  if (error || data === null) throw new Error(`No active signing key is available: ${error?.message ?? "none stored"}`);
  return new Signer(parseNodeIdentity(process.env).domain, { keyId: data.key_id, privateSeed: Buffer.from(data.private_key, "base64") });
}

const signedClient = new SignedClient(currentSigner, http);

/** Partner operations over the given repository — pass one built on the acting user's client. */
export function partnerService(partners: PartnerRepository): PartnerService {
  return new PartnerService({ ownDomain: parseNodeIdentity(process.env).domain, partners, wellKnown, client: signedClient });
}

function syncEngine() {
  const db = serviceClient();
  const partners = new SupabasePartnerRepository(db);
  return {
    partners,
    engine: new SyncEngine({
      client: signedClient,
      partners,
      copies: new SupabaseCopyRepository(db),
      sanitiser: descriptionSanitiser,
      registry: vendoredRegistry,
    }),
  };
}

export async function syncPartner(partnerId: string): Promise<SyncOutcome> {
  const { partners, engine } = syncEngine();
  const partner = await partners.findById(partnerId);
  if (partner === null) return { status: "skipped", reason: "No such partner." };
  return engine.syncPartner(partner);
}

export interface SyncRunResult {
  domain: string;
  outcome: SyncOutcome;
}

/** One scheduled pass: every partner that is due, one after another. `force` ignores the failure backoff. */
export async function syncDuePartners(options: { force: boolean }): Promise<SyncRunResult[]> {
  const { partners, engine } = syncEngine();
  const now = new Date();
  const results: SyncRunResult[] = [];
  for (const partner of await partners.list()) {
    if (partner.trustLevel !== "verified") continue;
    const outcome: SyncOutcome =
      options.force || isSyncDue(partner, now)
        ? await engine.syncPartner(partner)
        : { status: "skipped", reason: "Backing off after repeated failures." };
    results.push({ domain: partner.domain, outcome });
  }
  return results;
}

/**
 * Re-decides every live copy of a partner after its acceptance policy changed.
 * Copies are always stored whatever the policy, so loosening it publishes the
 * backlog at once and tightening it withdraws it — no re-sync needed.
 */
export async function reapplyAcceptancePolicy(partner: Partner): Promise<number> {
  const copies = new SupabaseCopyRepository(serviceClient());
  let changed = 0;
  for (const copy of await copies.listLiveByPartner(partner.id)) {
    if (copy.payload === null) continue;
    const decision = decideDisplay(copy.payload, partner.acceptancePolicy);
    if (decision.displayState === copy.displayState && decision.heldReasons.join("|") === copy.heldReasons.join("|")) continue;
    await copies.setDisplay(copy.canonicalUri, decision);
    changed++;
  }
  return changed;
}
