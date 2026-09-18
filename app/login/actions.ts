"use server";

import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";

export interface LoginFormState {
  message: string | null;
}

export async function signInAction(_previous: LoginFormState, form: FormData): Promise<LoginFormState> {
  const supabase = await userClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
  });
  // One message for every failure: which half was wrong is not the caller's to learn.
  if (error) return { message: "That email and password do not match an account." };
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  const supabase = await userClient();
  await supabase.auth.signOut();
  redirect("/login");
}
