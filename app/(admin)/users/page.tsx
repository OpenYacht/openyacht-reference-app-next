import { Alert, AlertContent, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import { requireRole } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";
import { InviteUserForm, ManageUser, type RoleOption } from "./user-forms";

export const dynamic = "force-dynamic";

interface Account {
  id: string;
  email: string;
  role: string | null;
  created_at: string;
  invited_at: string | null;
  confirmed_at: string | null;
  last_sign_in_at: string | null;
  manageable: boolean;
}

interface RoleEvent {
  id: number;
  user_email: string | null;
  old_role: string | null;
  new_role: string | null;
  changed_by_email: string | null;
  changed_at: string;
}

const day = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 10);
const minute = (timestamp: string) => `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function accountState(account: Account): string {
  if (account.last_sign_in_at !== null) return `last signed in ${day(account.last_sign_in_at)}`;
  if (account.confirmed_at === null && account.invited_at !== null) return `invited ${day(account.invited_at)}, not yet accepted`;
  return "never signed in";
}

export default async function UsersPage({ searchParams }: PageProps<"/users">) {
  const session = await requireRole("admin");
  const { deleted } = await searchParams;
  const supabase = await userClient();

  // All three reads as the signed-in user: list_users() and the role-change
  // record admit administrators only, and `manageable` is the database's own
  // answer to "may this person act on that account".
  const [accounts, { data: roles }, { data: events }] = await Promise.all([
    supabase.rpc("list_users"),
    supabase.from("roles").select("name, rank, description").order("rank", { ascending: false }),
    supabase
      .from("user_role_events")
      .select("id, user_email, old_role, new_role, changed_by_email, changed_at")
      .order("changed_at", { ascending: false })
      .limit(20),
  ]);
  if (accounts.error) throw new Error(accounts.error.message);
  // The client is untyped: the rows are what the function declares.
  const users = (accounts.data ?? []) as Account[];
  const history = (events ?? []) as RoleEvent[];

  // What this administrator may give. The database enforces the same rule;
  // this only keeps impossible choices out of the lists.
  const ownRank = roles?.find((role) => role.name === session.role)?.rank ?? 0;
  const assignable: RoleOption[] = (roles ?? [])
    .filter((role) => session.role === "super_admin" || role.rank < ownRank)
    .map(({ name, description }) => ({ name, description }));

  return (
    <main className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-muted mt-1 text-sm">
          Accounts on this node and their roles. Only a super admin gives the super admin role; an admin manages accounts ranked below their own;
          nobody changes their own role.
        </p>
      </header>

      {deleted === "1" && (
        <Alert status="success">
          <AlertContent>
            <AlertDescription>Account deleted. Listings that were assigned to it are now unassigned.</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted border-border border-b text-xs uppercase">
            <tr>
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 font-medium">Manage</th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => (
              <tr key={account.id} className="border-border border-b align-top">
                <td className="py-3 pr-4">
                  <div className="font-medium">{account.email}</div>
                  <div className="text-muted text-xs">{accountState(account)}</div>
                </td>
                <td className="py-3 pr-4">{account.role === null ? <Chip color="warning">no role</Chip> : <Chip>{account.role}</Chip>}</td>
                <td className="py-3">
                  {account.id === session.userId ? (
                    <span className="text-muted">you</span>
                  ) : account.manageable ? (
                    <details>
                      <summary className="cursor-pointer select-none">Manage</summary>
                      <ManageUser userId={account.id} role={account.role} roles={assignable} />
                    </details>
                  ) : (
                    <span className="text-muted">outranks you</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a user</CardTitle>
          <CardDescription>Creates the account and gives it a role at once.</CardDescription>
        </CardHeader>
        <CardContent>
          <InviteUserForm roles={assignable} />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent role changes</h2>
        {history.length === 0 ? (
          <p className="text-muted text-sm">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {history.map((event) => (
              <li key={event.id}>
                <span className="text-muted">{minute(event.changed_at)}</span> {event.user_email ?? "a deleted account"}:{" "}
                {event.old_role ?? "no role"} → {event.new_role ?? "no role"}
                <span className="text-muted"> by {event.changed_by_email ?? "setup"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
