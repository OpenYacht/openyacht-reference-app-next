"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/components/action-form";
import { userClient } from "@/lib/supabase/server";

export async function signInAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await userClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
  });
  // One message for every failure: which half was wrong is not the caller's to learn.
  if (error) return { ok: false, message: "That email and password do not match an account." };
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  const supabase = await userClient();
  await supabase.auth.signOut();
  redirect("/login");
}
