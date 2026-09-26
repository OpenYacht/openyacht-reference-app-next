"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

// Changing what a role may do. set_role_permissions() decides who may: it
// takes roles.manage, touches only roles ranked below the caller's own, and
// moves only permissions the caller holds.
export async function setRolePermissionsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("roles.manage");
  const role = String(form.get("role") ?? "");
  const permissions = form.getAll("permissions").map(String);

  const { error } = await (await userClient()).rpc("set_role_permissions", { p_role: role, p_permissions: permissions });
  if (error) return { ok: false, message: error.message };

  revalidatePath("/roles");
  return { ok: true, message: `Saved. Everyone with the ${role} role has these permissions from their next page load.` };
}
