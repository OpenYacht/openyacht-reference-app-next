import "server-only";
import { currentSigningKeyId, InMemoryReplayGuard, parseNodeIdentity, Verifier, type PartnerStore } from "@/federation";
import { serviceClient } from "@/lib/supabase/service";
import { wellKnown } from "./consumer";
import type { InboundFederation } from "./handlers";
import { SupabasePartnerRepository } from "./repositories";

// Inbound federation bound to this application. Everything here runs with the
// service role: the caller is a partner node authenticated by its signature,
// not a signed-in user, so there is no user whose row level security could apply.

// Per process. On a host that runs several instances this is best effort —
// see federation/replay-guard.ts.
const replayGuard = new InMemoryReplayGuard();

function partnerStore(repository: SupabasePartnerRepository): PartnerStore {
  return {
    findByDomain: (domain) => repository.findByDomain(domain),

    async updateCachedKeys(domain, keys) {
      const partner = await repository.findByDomain(domain);
      // The verifier's own refetch refreshes the cached keys and nothing else:
      // moving a pin takes an administrator (FP-12).
      if (partner !== null) await repository.updateDiscovery(partner.id, { nodeName: partner.nodeName, keys });
    },

    async downgradeToProvisional(domain, change) {
      const partner = await repository.findByDomain(domain);
      if (partner !== null) await repository.recordUuidChange(partner.id, change.newUuid);
    },

    async registerFirstContact(domain, discovered) {
      try {
        const partner = await repository.create({
          domain,
          nodeUuid: discovered.nodeUuid,
          nodeName: discovered.name,
          // Known, not trusted: nothing is shared until a person here approves (FP-13).
          trustLevel: "provisional",
          keys: discovered.keys,
          // Pinned from first contact. Between now and approval, a change of
          // key is exactly what an administrator should be asked about.
          pinnedKeyId: currentSigningKeyId(discovered.keys),
          acceptancePolicy: "hold",
        });
        await repository.markFirstContact(partner.id, new Date());
        return partner;
      } catch (error) {
        // Two first requests can arrive together; the unique domain lets one win.
        const existing = await repository.findByDomain(domain);
        if (existing !== null) return existing;
        throw error;
      }
    },
  };
}

async function raiseAlert(kind: "first_contact" | "node_uuid_changed", domain: string, nodeName: string | null, detail: Record<string, string>) {
  try {
    const db = serviceClient();
    const { data: partner } = await db.from("federation_partners").select("id, node_name").eq("domain", domain).maybeSingle();
    const { error } = await db.from("federation_alerts").insert({
      kind,
      domain,
      partner_id: partner?.id ?? null,
      node_name: nodeName ?? partner?.node_name ?? null,
      detail,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    // The request's answer does not depend on the alert; the console line above still stands.
    console.error(`[openyacht] could not raise a ${kind} alert for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const inboundFederation: InboundFederation = {
  verify(request) {
    const repository = new SupabasePartnerRepository(serviceClient());
    return new Verifier({
      ownDomain: parseNodeIdentity(process.env).domain,
      partners: partnerStore(repository),
      wellKnown,
      replayGuard,
      // FP-13 and FP-11 require administrators to be told. The alert waits on
      // the dashboard of everyone holding federation.notifications.
      observer: {
        async firstContact({ domain, nodeName }) {
          console.info(`[openyacht] first contact from ${domain} (${nodeName}) — registered as provisional, awaiting approval`);
          await raiseAlert("first_contact", domain, nodeName, {});
        },
        async nodeUuidChanged({ domain, previousUuid, newUuid }) {
          console.warn(`[openyacht] ${domain} now reports a different node UUID — downgraded to provisional, awaiting re-approval`);
          await raiseAlert("node_uuid_changed", domain, null, { previous_uuid: previousUuid, new_uuid: newUuid });
        },
      },
    }).verify(request);
  },

  async recordPartnerRequest(domain, request) {
    const repository = new SupabasePartnerRepository(serviceClient());
    const partner = await repository.findByDomain(domain);
    if (partner !== null) await repository.recordPartnerRequest(partner.id, request, new Date());
  },

  async log(entry) {
    try {
      const db = serviceClient();
      const partner =
        entry.partnerDomain === null ? null : await db.from("federation_partners").select("id").eq("domain", entry.partnerDomain).maybeSingle();
      const { error } = await db.from("federation_request_log").insert({
        request_id: entry.requestId,
        sender_domain: entry.senderDomain,
        partner_id: partner?.data?.id ?? null,
        method: entry.method,
        path: entry.path,
        outcome: entry.outcome,
        http_status: entry.status,
      });
      if (error) console.error(`[openyacht] could not write the request log: ${error.message}`);
    } catch (error) {
      // A logging failure must never turn a good federation response into a bad one.
      console.error(`[openyacht] could not write the request log: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
