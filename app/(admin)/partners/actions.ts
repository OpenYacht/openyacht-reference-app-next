"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { BlockedOutboundHost, PartnerError, WellKnownError, type AcceptancePolicy, type Partner } from "@/federation";
import { requirePermission, type Session } from "@/lib/auth/session";
import { partnerService, reapplyAcceptancePolicy, syncPartner } from "@/lib/federation/consumer";
import { RepositoryError, SupabasePartnerRepository } from "@/lib/federation/repositories";
import { userClient } from "@/lib/supabase/server";

// Every action here is a public POST endpoint, so each one establishes for
// itself who is calling. Partner management needs federation.manage. The writes
// then run as that user, under row level security — the database refuses them
// too if this check were ever wrong.

export interface ActionState {
  ok: boolean;
  message: string | null;
}

const POLICIES: AcceptancePolicy[] = ["accept_all", "accept_matching", "hold"];

async function context(): Promise<{ session: Session; partners: SupabasePartnerRepository }> {
  const session = await requirePermission("federation.manage");
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
    if (form.get("trust_level") === "verified") {
      await partners.setTrustLevel(partner.id, "verified");
      revalidatePath(`/partners/${partner.id}`);
      return { ok: true, message: "Partner approved." };
    }
    if (form.get("confirmed") !== "yes") return { ok: false, message: "Confirm that the partnership is to end." };
    const ended = await partnerService(partners).block(partner);
    revalidatePath(`/partners/${partner.id}`);
    return {
      ok: true,
      message: `Partner blocked. Nothing further is synchronised from it, and ${ended} listing${ended === 1 ? " whose" : "s whose"} terms end with the partnership ${ended === 1 ? "has" : "have"} been dropped.`,
    };
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

const FIELD_GROUP_NAMES = ["pricing", "location_exact", "media_original", "documents", "vessel_identifiers", "history"];

export async function setFieldGroupsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const groups = form
      .getAll("field_groups")
      .map(String)
      .filter((group) => FIELD_GROUP_NAMES.includes(group));
    // One database function changes the grants and re-announces this partner's
    // listings to it — otherwise it would go on holding the old view, since no
    // listing has changed.
    const { data, error } = await (await userClient()).rpc("set_partner_field_groups", { p_partner_id: Number(partner.id), p_field_groups: groups });
    if (error) return { ok: false, message: error.message };
    revalidatePath(`/partners/${partner.id}`);
    return {
      ok: true,
      message:
        data === 0
          ? "Saved."
          : `Saved. ${data} listing${data === 1 ? "" : "s"} will be sent to this partner again, in the new form, on its next poll.`,
    };
  } catch (error) {
    return explain(error);
  }
}

export async function setRateLimitAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const entered = String(form.get("rate_per_hour") ?? "").trim();
    if (entered !== "" && !/^[1-9]\d{0,5}$/.test(entered))
      return { ok: false, message: "Enter a whole number of requests per hour, or leave it empty for the default." };

    const { error } = await (
      await userClient()
    )
      .from("federation_partners")
      .update({ rate_per_hour: entered === "" ? null : Number(entered) })
      .eq("id", partner.id);
    if (error) return { ok: false, message: error.message };
    revalidatePath(`/partners/${partner.id}`);
    return {
      ok: true,
      message: entered === "" ? "Saved. This partner is held to the node's default." : `Saved. This partner may make ${entered} requests an hour.`,
    };
  } catch (error) {
    return explain(error);
  }
}

// ---------------------------------------------------------------------------
// Which listings a partner receives: its sharing scope, what is shared with it
// directly, and partner groups. Each goes through one database function that
// makes the change and records every (listing, partner) visibility it moved.
// ---------------------------------------------------------------------------

const viewsChanged = (count: number) =>
  count === 0
    ? "No listing's visibility changed."
    : `${count} listing${count === 1 ? "'s visibility" : "s' visibility"} changed; the partner is told on its next poll.`;

export async function setSharingScopeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const scope = form.get("sharing_scope") === "curated" ? "curated" : "standard";
    const { data, error } = await (await userClient()).rpc("set_partner_sharing_scope", { p_partner_id: Number(partner.id), p_scope: scope });
    if (error) return { ok: false, message: error.message };
    revalidatePath(`/partners/${partner.id}`);
    return { ok: true, message: `Saved. ${viewsChanged(data as number)}` };
  } catch (error) {
    return explain(error);
  }
}

export async function setDirectSharesAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const type = form.get("listing_type") === "charter" ? "charter" : "sale";
    const ids = form.getAll("listing_ids").map(Number).filter(Number.isInteger);
    // Scoped to one type in the database, so this form cannot unshare the other type's listings.
    const { data, error } = await (
      await userClient()
    ).rpc("set_partner_direct_shares", {
      p_partner_id: Number(partner.id),
      p_listing_type: type,
      p_listing_ids: ids,
    });
    if (error) return { ok: false, message: error.message };
    revalidatePath(`/partners/${partner.id}`);
    return { ok: true, message: `Saved. ${viewsChanged(data as number)}` };
  } catch (error) {
    return explain(error);
  }
}

/** Current members of a group, read before a change so the partners who leave are re-decided too. */
async function groupMembers(groupId: number | null): Promise<number[]> {
  if (groupId === null) return [];
  const { data } = await (await userClient()).from("partner_group_members").select("partner_id").eq("group_id", groupId);
  return (data ?? []).map((row) => row.partner_id as number);
}

/** A group's acceptance policy feeds its members' display decisions, so they are made again. */
async function redecideDisplay(partners: SupabasePartnerRepository, partnerIds: number[]): Promise<number> {
  let changed = 0;
  for (const id of new Set(partnerIds)) {
    const partner = await partners.findById(String(id));
    if (partner !== null) changed += await reapplyAcceptancePolicy(partner);
  }
  return changed;
}

export async function saveGroupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const { partners } = await context();
  const groupId = form.get("group_id") ? Number(form.get("group_id")) : null;
  const name = String(form.get("name") ?? "").trim();
  if (name === "") return { ok: false, message: "A group needs a name." };
  const members = form.getAll("member_ids").map(Number).filter(Number.isInteger);
  const policy = String(form.get("acceptance_policy") ?? "");
  const before = await groupMembers(groupId);
  const { error } = await (
    await userClient()
  ).rpc("save_partner_group", {
    p_group_id: groupId,
    p_name: name,
    p_member_ids: members,
    p_acceptance_policy: POLICIES.includes(policy as AcceptancePolicy) ? policy : null,
  });
  if (error) return { ok: false, message: error.message.includes("duplicate key") ? "There is already a group with that name." : error.message };
  const changed = await redecideDisplay(partners, [...before, ...members]);
  revalidatePath("/partners/groups");
  const displayed = changed === 0 ? "" : ` ${changed} stored listing${changed === 1 ? "" : "s"} changed display state.`;
  return { ok: true, message: (groupId === null ? `Group "${name}" created.` : "Saved.") + displayed };
}

export async function deleteGroupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const { partners } = await context();
  if (form.get("confirmed") !== "yes") return { ok: false, message: "Confirm that the group is to be deleted." };
  const groupId = Number(form.get("group_id"));
  const before = await groupMembers(groupId);
  const { error } = await (await userClient()).rpc("delete_partner_group", { p_group_id: groupId });
  if (error) return { ok: false, message: error.message };
  await redecideDisplay(partners, before);
  // The form lived in the deleted group's card; the page reports instead.
  revalidatePath("/partners/groups");
  redirect("/partners/groups?deleted=1");
}

export async function setImportTypesAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { partners } = await context();
    const partner = await loadPartner(partners, form);
    const value = String(form.get("import_types"));
    const importTypes = value === "sale" || value === "charter" ? value : "both";
    await partners.setImportTypes(partner.id, importTypes);
    const changed = await reapplyAcceptancePolicy({ ...partner, importTypes });
    revalidatePath(`/partners/${partner.id}`);
    return { ok: true, message: `Saved. ${changed} stored listing${changed === 1 ? "" : "s"} changed display state.` };
  } catch (error) {
    return explain(error);
  }
}
