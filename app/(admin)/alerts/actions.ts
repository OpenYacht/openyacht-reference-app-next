"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

export async function dismissAlertAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("federation.notifications");
  const { error } = await (await userClient()).rpc("resolve_federation_alert", { p_alert_id: Number(form.get("alert_id")) });
  if (error) return { ok: false, message: error.message };
  revalidatePath("/");
  return { ok: true, message: null };
}
