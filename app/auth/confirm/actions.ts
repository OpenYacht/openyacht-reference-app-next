"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { userClient } from "@/lib/supabase/server";

// Spends a one-time link made on the Users screen: an invitation, or a
// password reset. Verifying signs the person in, and the next stop is choosing
// a password.
export async function confirmLinkAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const tokenHash = String(form.get("token_hash") ?? "");
  const type = form.get("type") === "recovery" ? "recovery" : "invite";
  const { error } = await (await userClient()).auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return { ok: false, message: "This link has expired or has already been used. Ask an administrator for a new one." };
  redirect("/account?choose=password");
}
