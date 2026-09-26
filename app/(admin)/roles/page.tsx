import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@heroui/react";
import { can, requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";
import { RolePermissionsForm } from "./role-permissions-form";

export const dynamic = "force-dynamic";

interface PermissionEvent {
  id: number;
  role: string;
  added: string[];
  removed: string[];
  changed_by_email: string | null;
  changed_at: string;
}

const minute = (timestamp: string) => `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function RolesPage() {
  // Readable by anyone who manages users, so they can see what a role they
  // give will allow; editable with roles.manage.
  const session = await requirePermission("users.manage", "roles.manage");
  const supabase = await userClient();
  const [{ data: roles }, { data: permissions }, { data: matrix }, { data: events }] = await Promise.all([
    supabase.from("roles").select("name, rank, description").order("rank", { ascending: false }),
    supabase.from("permissions").select("name, description").order("position"),
    supabase.from("role_permissions").select("role, permission"),
    supabase
      .from("role_permission_events")
      .select("id, role, added, removed, changed_by_email, changed_at")
      .order("changed_at", { ascending: false })
      .limit(20),
  ]);

  const ownRank = (roles ?? []).find((role) => role.name === session.role)?.rank ?? 0;
  const editor = can(session, "roles.manage");
  const heldBy = (role: string) => (matrix ?? []).filter((row) => row.role === role).map((row) => row.permission as string);
  const history = (events ?? []) as PermissionEvent[];

  return (
    <main className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Roles</h1>
        <p className="text-muted mt-1 text-sm">
          What each role may do. Every role reads listings and partner listings; a role limited to its own listings reads only those. The super admin
          role holds every permission and cannot be changed.
          {editor && " You can change roles ranked below your own, and only the permissions you hold yourself."}
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        {(roles ?? []).map((role) => {
          const editable = editor && role.name !== "super_admin" && role.rank < ownRank;
          const held = role.name === "super_admin" ? (permissions ?? []).map((p) => p.name as string) : heldBy(role.name);
          return (
            <Card key={role.name}>
              <CardHeader>
                <CardTitle className="font-mono">{role.name}</CardTitle>
                <CardDescription>{role.description}</CardDescription>
              </CardHeader>
              <CardContent>
                {editable ? (
                  <RolePermissionsForm
                    role={role.name}
                    held={held}
                    options={(permissions ?? []).map((p) => ({ name: p.name, description: p.description, movable: session.permissions.has(p.name) }))}
                  />
                ) : held.length === 0 ? (
                  <p className="text-muted text-sm">Read only.</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {held.map((name) => (
                      <li key={name} className="font-mono">
                        {name}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent changes</h2>
        {history.length === 0 ? (
          <p className="text-muted text-sm">The shipped defaults, unchanged.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {history.map((event) => (
              <li key={event.id}>
                <span className="text-muted">{minute(event.changed_at)}</span> <span className="font-mono">{event.role}</span>
                {event.added.length > 0 && <> gained {event.added.join(", ")}</>}
                {event.added.length > 0 && event.removed.length > 0 && ";"}
                {event.removed.length > 0 && <> lost {event.removed.join(", ")}</>}
                <span className="text-muted"> by {event.changed_by_email ?? "the system"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
