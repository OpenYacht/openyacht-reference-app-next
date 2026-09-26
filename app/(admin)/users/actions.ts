"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { confirmLink, createInvitedAccount, createRecoveryToken, deleteAccount } from "@/lib/auth/accounts";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

// User management. Who may do what is decided in the database, as the
// signed-in user: the user_roles policies and the checks of the same name (see
// the user_management migration). Nothing here repeats those rules; it asks,
// and reports the answer.

const failed = (message: string): ActionState => ({ ok: false, message });

/** The origin this admin screen was reached on, so a link works wherever the administrator is. */
async function origin(): Promise<string> {
  const list = await headers();
  const host = list.get("x-forwarded-host") ?? list.get("host") ?? "localhost:3000";
  const proto = list.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

async function ask(check: "can_manage_user" | "can_assign_role", argument: string): Promise<boolean> {
  const { data, error } = await (await userClient()).rpc(check, check === "can_manage_user" ? { p_user_id: argument } : { p_role: argument });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function inviteUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("users.manage");
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const role = String(form.get("role") ?? "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return failed("Enter a valid email address.");
  if (!(await ask("can_assign_role", role))) return failed("You cannot give that role.");

  const created = await createInvitedAccount(email);
  if ("error" in created) return failed(`The account was not created: ${created.error}`);

  // The role is written as the signed-in user, so the policies decide it.
  const { error } = await (await userClient()).from("user_roles").insert({ user_id: created.userId, role });
  if (error) {
    // An account nobody can use is not left behind.
    await deleteAccount(created.userId);
    return failed(`The account was not created: ${error.message}`);
  }

  revalidatePath("/users");
  return {
    ok: true,
    message: `Account created for ${email} as ${role}. Send them this link to choose a password. It works once, and expires after the project's email link lifetime (an hour unless changed in Supabase).`,
    link: confirmLink(await origin(), created.tokenHash, "invite"),
  };
}

export async function setRoleAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("users.manage");
  const userId = String(form.get("user_id") ?? "");
  const role = String(form.get("role") ?? "");
  if (!(await ask("can_manage_user", userId))) return failed("You cannot change this account's role.");

  const supabase = await userClient();
  if (role === "") {
    const { error } = await supabase.from("user_roles").delete().eq("user_id", userId);
    if (error) return failed(error.message);
    revalidatePath("/users");
    return { ok: true, message: "Role removed. The account can sign in but sees nothing." };
  }

  if (!(await ask("can_assign_role", role))) return failed("You cannot give that role.");
  // Update first; no row updated means the account has no role yet. The
  // pre-flight check above rules out the other reason an update matches
  // nothing (a policy filtering the row out).
  const { data, error } = await supabase.from("user_roles").update({ role }).eq("user_id", userId).select("user_id");
  if (error) return failed(error.message);
  if (data.length === 0) {
    const { error: insertError } = await supabase.from("user_roles").insert({ user_id: userId, role });
    if (insertError) return failed(insertError.message);
  }
  revalidatePath("/users");
  return { ok: true, message: `Role set to ${role}. It applies from their next page load.` };
}

export async function passwordLinkAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("users.manage");
  const userId = String(form.get("user_id") ?? "");
  if (!(await ask("can_manage_user", userId))) return failed("You cannot reset this account's password.");

  const token = await createRecoveryToken(userId);
  if ("error" in token) return failed(`No link was made: ${token.error}`);
  return {
    ok: true,
    message: "Send this link to the account's owner. It lets them choose a new password, works once, and expires like an invitation.",
    link: confirmLink(await origin(), token.tokenHash, "recovery"),
  };
}

export async function deleteUserAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requirePermission("users.manage");
  const userId = String(form.get("user_id") ?? "");
  if (form.get("confirmed") !== "yes") return failed("Confirm that the account is to be deleted.");
  if (!(await ask("can_manage_user", userId))) return failed("You cannot delete this account.");

  // The role goes first, as the signed-in user, so its removal is recorded
  // against them and the last-super-admin rule is applied before anything
  // irreversible happens.
  const { error } = await (await userClient()).from("user_roles").delete().eq("user_id", userId);
  if (error) return failed(error.message);
  const deleted = await deleteAccount(userId);
  if (deleted) return failed(`The role was removed but the account was not deleted: ${deleted.error}`);

  // The form that asked lived in the deleted account's row, so the answer is
  // given by the page instead.
  revalidatePath("/users");
  redirect("/users?deleted=1");
}
