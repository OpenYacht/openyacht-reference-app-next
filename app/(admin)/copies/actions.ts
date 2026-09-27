"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

// ID-9: a vessel-identity conflict is never resolved automatically. This
// records that a person looked at both listings and chose to proceed; the
// sync engine clears it if the set of rivals changes.
export async function reviewConflictAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("listings.manage");
  if (form.get("confirmed") !== "yes") return { ok: false, message: "Confirm that you have compared both listings." };
  const canonicalUri = String(form.get("canonical_uri") ?? "");
  const { error } = await (await userClient()).rpc("review_copy_conflict", { p_canonical_uri: canonicalUri });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/copies");
  return { ok: true, message: "Reviewed. The listing follows its partner's policy again, until another authority claims the vessel." };
}
