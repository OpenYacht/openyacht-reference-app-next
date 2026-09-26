"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { userClient } from "@/lib/supabase/server";

// The hourly sync job: pg_cron in the database calls POST /api/internal/sync on
// the identity domain. See the scheduled_sync migration.

const failed = (message: string): ActionState => ({ ok: false, message });

export async function scheduleSyncAction(): Promise<ActionState> {
  await requirePermission("federation.manage");
  // Read from this server's environment, never from the form: the job must
  // present the secret the deployed route checks.
  const secret = optionalEnv("INTERNAL_API_SECRET");
  if (secret === undefined) return failed("INTERNAL_API_SECRET is not set in this server's environment.");

  // As the signed-in user: the function checks for federation.manage itself.
  const { data: minute, error } = await (await userClient()).rpc("schedule_sync", { p_secret: secret });
  if (error) return failed(`Synchronisation was not scheduled: ${error.message}`);

  revalidatePath("/");
  return { ok: true, message: `Partners are synchronised every hour at ${String(minute).padStart(2, "0")} minutes past.` };
}

export async function unscheduleSyncAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("federation.manage");
  if (form.get("confirmed") !== "yes") return failed("Confirm that scheduled synchronisation is to stop.");

  const { error } = await (await userClient()).rpc("unschedule_sync");
  if (error) return failed(`The schedule was not removed: ${error.message}`);

  revalidatePath("/");
  return { ok: true, message: "Scheduled synchronisation has stopped. Copies go stale until it is registered again or `pnpm sync` is run." };
}
