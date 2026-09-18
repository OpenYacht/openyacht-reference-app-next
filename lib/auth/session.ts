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

const RANK: Record<Role, number> = { super_admin: 100, admin: 80, editor: 60, broker: 40, viewer: 20 };

export const hasRole = (session: Session, minimum: Role) => session.role !== null && RANK[session.role] >= RANK[minimum];

/**
 * For pages and Server Actions restricted to a role. Row level security
 * enforces the same rule in the database; this is what turns a refused query
 * into a clear answer instead of an empty page.
 */
export async function requireRole(minimum: Role): Promise<Session> {
  const session = await requireSession();
  if (!hasRole(session, minimum)) redirect("/");
  return session;
}
