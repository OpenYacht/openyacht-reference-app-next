import "server-only";
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";

export type Role = "super_admin" | "admin" | "editor" | "broker" | "viewer";

export interface Session {
  userId: string;
  email: string | null;
  /** Null for an account that holds no role: signed in, but allowed nothing. */
  role: Role | null;
}

/**
 * The verified caller and their role, or a redirect to /login. Pages and
 * Server Actions call this themselves — the proxy only routes. The role is
 * read under RLS as the user, through the "users read their own role" policy.
 */
export async function requireSession(): Promise<Session> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");

  const { data: row } = await supabase.from("user_roles").select("role").eq("user_id", data.claims.sub).maybeSingle();
  return { userId: data.claims.sub, email: data.claims.email ?? null, role: (row?.role as Role | undefined) ?? null };
}
