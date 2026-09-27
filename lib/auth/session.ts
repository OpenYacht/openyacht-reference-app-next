import "server-only";
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";

export type Role = "super_admin" | "admin" | "editor" | "broker" | "viewer";

/** The permissions of the matrix (the permissions migration). A role's set is data; super_admin holds all of them. */
export type Permission =
  | "users.manage"
  | "roles.manage"
  | "listings.manage"
  | "listings.manage_own"
  | "federation.manage"
  | "federation.notifications"
  | "activity-log.view"
  | "api-keys.manage";

export interface Session {
  userId: string;
  email: string | null;
  /** Null for an account that holds no role: signed in, but allowed nothing. */
  role: Role | null;
  permissions: ReadonlySet<Permission>;
}

/**
 * The verified caller, their role and what the matrix lets that role do, or a
 * redirect to /login. Pages and Server Actions call this themselves — the
 * proxy only routes. Both reads run under RLS as the user.
 */
export async function requireSession(): Promise<Session> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");

  const [{ data: row }, { data: permissions }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", data.claims.sub).maybeSingle(),
    supabase.rpc("my_permissions"),
  ]);
  return {
    userId: data.claims.sub,
    email: data.claims.email ?? null,
    role: (row?.role as Role | undefined) ?? null,
    permissions: new Set((permissions ?? []) as Permission[]),
  };
}

/** Whether the session holds any of the permissions. */
export const can = (session: Session, ...permissions: Permission[]) => permissions.some((permission) => session.permissions.has(permission));

/**
 * For pages and Server Actions that need a permission (any of those given).
 * Row level security enforces the same rule in the database; this is what
 * turns a refused query into a clear answer instead of an empty page.
 */
export async function requirePermission(...permissions: Permission[]): Promise<Session> {
  const session = await requireSession();
  if (!can(session, ...permissions)) redirect("/");
  return session;
}
