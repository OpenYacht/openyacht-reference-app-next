"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canTransition, type ListingStatus } from "@/federation";
import type { ActionState } from "@/components/action-form";
import { requireRole } from "@/lib/auth/session";
import { builderChoices, categoryChoices } from "@/lib/federation/registry";
import { descriptionSanitiser } from "@/lib/federation/sanitiser";
import { parseListingForm, withOverview } from "@/lib/listings/listing-form";
import { userClient } from "@/lib/supabase/server";

// Every write here runs as the signed-in user. Row level security decides
// whether it may happen — an editor anywhere, a broker on their own listings —
// and the database enforces the invariants (immutable type, lifecycle, price
// history, the wire timestamp). These actions validate the form and report.

const formDeps = { builders: builderChoices, categories: categoryChoices, sanitiser: descriptionSanitiser };
const failed = (message: string): ActionState => ({ ok: false, message });

export async function createListingAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireRole("broker");
  const parsed = parseListingForm(form, formDeps);
  if (!parsed.ok) return failed(parsed.errors.join(" "));
  const supabase = await userClient();

  // A vessel for sale and for charter is one vessel with two listings, so a
  // new listing may be attached to a vessel that already exists.
  let vesselId = Number(form.get("vessel_id")) || null;
  if (vesselId === null) {
    const { data, error } = await supabase.from("vessels").insert(parsed.vessel).select("id").single();
    if (error) return failed(`The vessel could not be saved: ${error.message}`);
    vesselId = data.id;
  }

  const { overview, broker, specifications, charter, ...columns } = parsed.listing;
  const { data, error } = await supabase
    .from("listings")
    .insert({
      ...columns,
      vessel_id: vesselId,
      listing_type: parsed.listingType,
      specifications,
      charter,
      descriptions: withOverview([], overview),
      brokers: broker === null ? [] : [broker],
      // A broker's listings are their own; an editor's are unassigned until given to someone.
      assigned_broker_id: session.role === "broker" ? session.userId : null,
    })
    .select("id")
    .single();
  if (error) return failed(`The listing could not be saved: ${error.message}`);
  revalidatePath("/listings");
  redirect(`/listings/${data.id}`);
}

export async function updateListingAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const parsed = parseListingForm(form, formDeps);
  if (!parsed.ok) return failed(parsed.errors.join(" "));
  const supabase = await userClient();
  const id = Number(form.get("listing_id"));

  const { data: existing } = await supabase
    .from("listings")
    .select("vessel_id, specifications, descriptions, brokers, charter")
    .eq("id", id)
    .maybeSingle();
  if (existing === null) return failed("No such listing, or it is not yours to change.");

  const { error: vesselError } = await supabase.from("vessels").update(parsed.vessel).eq("id", existing.vessel_id);
  if (vesselError) return failed(`The vessel could not be saved: ${vesselError.message}`);

  const { overview, broker, specifications, charter, ...columns } = parsed.listing;
  const otherBrokers = (existing.brokers as unknown[]).slice(1);
  const { error, count } = await supabase
    .from("listings")
    .update(
      {
        ...columns,
        // Laid over what is stored: blocks hold more than this form edits, and
        // a save must not erase the rest.
        specifications: { ...(existing.specifications as object), ...specifications },
        charter: charter === null ? null : { ...(existing.charter as object | null), ...charter },
        descriptions: withOverview(existing.descriptions as { section: string; content: string }[], overview),
        brokers: broker === null ? otherBrokers : [broker, ...otherBrokers],
      },
      { count: "exact" },
    )
    .eq("id", id);
  if (error) return failed(`The listing could not be saved: ${error.message}`);
  if (count === 0) return failed("The listing was not saved: it is not yours to change.");
  revalidatePath(`/listings/${id}`);
  return { ok: true, message: "Saved. Partners who can see this listing receive the change on their next poll." };
}

export async function setStatusAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const id = Number(form.get("listing_id"));
  const from = String(form.get("from")) as ListingStatus;
  const to = String(form.get("to")) as ListingStatus;
  // The database enforces this too (ID-8); checking here gives a clearer answer.
  if (!canTransition(from, to)) return failed(`A listing cannot go from ${from} to ${to}.`);

  const { error, count } = await (await userClient()).from("listings").update({ status: to }, { count: "exact" }).eq("id", id).eq("status", from);
  if (error) return failed(error.message);
  if (count === 0) return failed("The status was not changed: the listing has moved on, or it is not yours to change.");
  revalidatePath(`/listings/${id}`);
  const messages: Partial<Record<ListingStatus, string>> = {
    active: "The listing is live. Partners it is shared with receive it on their next poll.",
    under_offer: "Marked under offer.",
    sold: "Marked sold. Partners receive a tombstone and remove their copies. This is final.",
    withdrawn: "Withdrawn. Partners receive a tombstone and remove their copies. This is final.",
  };
  return { ok: true, message: messages[to] ?? "Status changed." };
}

export async function setSharingAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("broker");
  const id = Number(form.get("listing_id"));
  const audience = String(form.get("audience"));
  if (!["everyone", "selected", "none"].includes(audience)) return failed("Choose who this listing is shared with.");
  const partnerIds = form.getAll("partner_ids").map(Number).filter(Number.isInteger);

  // One database function changes the sharing and records what changed, in
  // that order, so that no partner misses a removal (API-3).
  const { data, error } = await (
    await userClient()
  ).rpc("set_listing_sharing", { p_listing_id: id, p_audience: audience, p_partner_ids: partnerIds });
  if (error) return failed(error.message);
  revalidatePath(`/listings/${id}`);
  return {
    ok: true,
    message:
      data === 0
        ? "Saved. No partner's view changed."
        : `Saved. ${data} partner${data === 1 ? "'s view" : "s' views"} changed; each is told on its next poll.`,
  };
}

export async function deleteDraftAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireRole("editor");
  const { error, count } = await (
    await userClient()
  )
    .from("listings")
    .delete({ count: "exact" })
    .eq("id", Number(form.get("listing_id")))
    .eq("status", "draft");
  if (error) return failed(error.message);
  if (count === 0) return failed("Only a draft can be deleted. A listing that has been distributed ends by being withdrawn or sold.");
  revalidatePath("/listings");
  redirect("/listings");
}
