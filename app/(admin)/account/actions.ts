"use server";

import type { ActionState } from "@/components/action-form";
import { requireSession } from "@/lib/auth/session";
import { MIN_PASSWORD_LENGTH } from "@/lib/node/setup";
import { userClient } from "@/lib/supabase/server";

export async function changePasswordAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireSession();
  const password = String(form.get("password") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `The password needs at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (password !== String(form.get("password_confirmation") ?? "")) return { ok: false, message: "The two passwords do not match." };

  const { error } = await (await userClient()).auth.updateUser({ password });
  if (error) return { ok: false, message: `The password was not changed: ${error.message}` };
  return { ok: true, message: "Password saved. Use it next time you sign in." };
}
