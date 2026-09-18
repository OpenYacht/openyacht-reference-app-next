"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { BlockedOutboundHost, PartnerError, WellKnownError, type AcceptancePolicy, type Partner } from "@/federation";
import { requireRole, type Session } from "@/lib/auth/session";
import { partnerService, reapplyAcceptancePolicy, syncPartner } from "@/lib/federation/consumer";
import { RepositoryError, SupabasePartnerRepository } from "@/lib/federation/repositories";
import { userClient } from "@/lib/supabase/server";

// Every action here is a public POST endpoint, so each one establishes for
// itself who is calling. Partner management is the super_admin's. The writes
// then run as that user, under row level security — the database refuses them
// too if this check were ever wrong.

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const POLICIES: AcceptancePolicy[] = ["accept_all", "accept_matching", "hold"];

async function context(): Promise<{ session: Session; partners: SupabasePartnerRepository }> {
  const session = await requireRole("super_admin");
  return { session, partners: new SupabasePartnerRepository(await userClient(), session.userId) };
}

async function loadPartner(partners: SupabasePartnerRepository, form: FormData): Promise<Partner> {
  const partner = await partners.findById(String(form.get("partner_id") ?? ""));
  if (partner === null) throw new PartnerError("No such partner.");
  return partner;
}

/** Errors an administrator can act on are shown; anything else is a bug and is thrown. */
function explain(error: unknown): ActionState {
  if (error instanceof PartnerError || error instanceof BlockedOutboundHost || error instanceof WellKnownError || error instanceof RepositoryError) {
    return { ok: false, message: error.message };
  }
  if (error instanceof Error && /fetched less than a minute ago|timed out|ENOTFOUND|ECONNREFUSED|certificate/i.test(error.message)) {
    return { ok: false, message: error.message };
  }
  throw error;
}

const INTRODUCTION: Record<string, string> = {
  delivered: "The partnership request was delivered. Their administrator now needs to approve this node.",
  accepted: "They already trust this node. Listings can be synchronised now.",
  blocked: "They have blocked this node.",
};

export async function addPartnerAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let partnerId: string;
  try {
    const { session, partners } = await context();
    const policy = String(form.get("acceptance_policy"));
    const message = String(form.get("message") ?? "").trim();
    const contactEmail = String(form.get("contact_email") ?? "").trim() || (session.email ?? "");
    if (!POLICIES.includes(policy as AcceptancePolicy)) return { ok: false, message: "Choose what happens to this partner's listings." };
    if (message === "" || contactEmail === "")
      return { ok: false, message: "A message and a contact email are both required: they are what the other administrator sees." };

    const service = partnerService(partners);
    const partner = await service.add(String(form.get("domain") ?? ""), {
      pinKey: form.get("pin_key") === "yes",
      acceptancePolicy: policy as AcceptancePolicy,
    });
    partnerId = partner.id;
    // The partner is saved before the introduction is attempted, so whatever
    // happens next is reported, never lost.
    await service.introduce(partner, { message, contactEmail });
  } catch (error) {
    return explain(error);
  }
  revalidatePath("/partners");
  redirect(`/partners/${partnerId}`);
}

export async function introduceAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { session, partners } = await context();
    const partner = await loadPartner(partners, form);
    if (partner.trustLevel === "blocked") return { ok: false, message: "This partner is blocked on this node." };
    const message = String(form.get("message") ?? "").trim();
    const contactEmail = String(form.get("contact_email") ?? "").trim() || (session.email ?? "");
    if (message === "" || contactEmail === "") return { ok: false, message: "A message and a contact email are both required." };

    const outcome = await partnerService(partners).introduce(partner, { message, contactEmail });
    revalidatePath(`/partners/${partner.id}`);
    return outcome.result === "failed"
      ? { ok: false, message: `The request was not delivered: ${outcome.reason}` }
      : { ok: outcome.result !== "blocked", message: INTRODUCTION[outcome.result]! };
  } catch (error) {
    return explain(error);
  }
}

export async function syncNowAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    // The sync itself runs with the service role: it writes copies, which no
    // signed-in user may write. The role check above is what authorises it.
    const outcome = await syncPartner(partner.id);
    revalidatePath(`/partners/${partner.id}`);
    switch (outcome.status) {
      case "synced":
        return {
          ok: true,
          message: `Synchronised: ${outcome.created} new, ${outcome.updated} updated, ${outcome.tombstoned} ended, ${outcome.unchanged} unchanged${outcome.rejected ? `, ${outcome.rejected} rejected` : ""}.`,
        };
      case "awaiting_approval":
        return { ok: true, message: "They have not approved this node yet — nothing to synchronise. This is not a failure; polling continues." };
      case "rate_limited":
        return {
          ok: false,
          message: `They are rate limiting this node${outcome.retryAfterSeconds === null ? "" : `; retry in ${outcome.retryAfterSeconds} seconds`}.`,
        };
      default:
        return { ok: false, message: outcome.reason };
    }
  } catch (error) {
    return explain(error);
  }
}

export async function refreshKeysAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const result = await partnerService(partners).refreshKeys(partner, { confirmPin: form.get("confirm_pin") === "yes" });
    revalidatePath(`/partners/${partner.id}`);
    if (result === "uuid_changed") {
      return {
        ok: false,
        message:
          "This domain now reports a different node UUID — a different installation. The partner has been set to provisional and needs your approval again. Its pin was not moved.",
      };
    }
    return { ok: true, message: result === "repinned" ? "Keys refreshed, and the pin moved to their current signing key." : "Keys refreshed." };
  } catch (error) {
    return explain(error);
  }
}

export async function setPolicyAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const policy = String(form.get("acceptance_policy")) as AcceptancePolicy;
    if (!POLICIES.includes(policy)) return { ok: false, message: "Unknown policy." };
    await partners.setAcceptancePolicy(partner.id, policy);
    const changed = await reapplyAcceptancePolicy({ ...partner, acceptancePolicy: policy });
    revalidatePath(`/partners/${partner.id}`);
    return { ok: true, message: `Policy saved. ${changed} stored listing${changed === 1 ? "" : "s"} changed display state.` };
  } catch (error) {
    return explain(error);
  }
}

export async function setTrustAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const trustLevel = form.get("trust_level") === "verified" ? "verified" : "blocked";
    await partners.setTrustLevel(partner.id, trustLevel);
    revalidatePath(`/partners/${partner.id}`);
    return { ok: true, message: trustLevel === "verified" ? "Partner approved." : "Partner blocked. Nothing further is synchronised from it." };
  } catch (error) {
    return explain(error);
  }
}

export async function removePartnerAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    await partnerService(partners).remove(await loadPartner(partners, form));
  } catch (error) {
    return explain(error);
  }
  revalidatePath("/partners");
  redirect("/partners");
}
