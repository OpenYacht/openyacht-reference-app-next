import { Chip } from "@heroui/react";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// What happened on this node, for anyone holding activity-log.view. Every
// table here is append-only and readable under RLS by that permission; this
// page only reads.

const LIMIT = 100;
const minute = (timestamp: string) => `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

interface RequestRow {
  id: number;
  occurred_at: string;
  sender_domain: string | null;
  method: string;
  path: string;
  outcome: string;
  http_status: number;
}

const SECTIONS = { requests: "Federation requests", roles: "Role changes", permissions: "Permission changes", alerts: "Alerts" } as const;
type Section = keyof typeof SECTIONS;

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  await requirePermission("activity-log.view");
  const params = await searchParams;
  const section: Section = typeof params.show === "string" && params.show in SECTIONS ? (params.show as Section) : "requests";
  const problemsOnly = params.problems === "1";
  const supabase = await userClient();

  let body: React.ReactNode;
  if (section === "requests") {
    let query = supabase
      .from("federation_request_log")
      .select("id, occurred_at, sender_domain, method, path, outcome, http_status")
      .order("occurred_at", { ascending: false })
      .limit(LIMIT);
    if (problemsOnly) query = query.neq("outcome", "ok");
    const { data } = await query;
    const rows = (data ?? []) as RequestRow[];
    body = (
      <>
        <p className="text-sm">
          {problemsOnly ? (
            <Link href="/activity?show=requests" className="underline underline-offset-4">
              Show every request
            </Link>
          ) : (
            <Link href="/activity?show=requests&problems=1" className="underline underline-offset-4">
              Show refused requests only
            </Link>
          )}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">From</th>
                <th className="py-2 pr-4 font-medium">Request</th>
                <th className="py-2 font-medium">Answer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-border border-b">
                  <td className="text-muted py-2 pr-4 whitespace-nowrap">{minute(row.occurred_at)}</td>
                  {/* As claimed in the request: unverified when the answer says so. */}
                  <td className="py-2 pr-4 font-mono text-xs">{row.sender_domain ?? "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs break-all">
                    {row.method} {row.path}
                  </td>
                  <td className="py-2">
                    <Chip color={row.outcome === "ok" ? "success" : "danger"}>
                      {row.http_status} {row.outcome}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  } else if (section === "roles") {
    const { data } = await supabase
      .from("user_role_events")
      .select("id, user_email, old_role, new_role, changed_by_email, changed_at")
      .order("changed_at", { ascending: false })
      .limit(LIMIT);
    body = (
      <ul className="flex flex-col gap-1 text-sm">
        {(data ?? []).map((event) => (
          <li key={event.id}>
            <span className="text-muted">{minute(event.changed_at)}</span> {event.user_email ?? "a deleted account"}: {event.old_role ?? "no role"} →{" "}
            {event.new_role ?? "no role"}
            <span className="text-muted"> by {event.changed_by_email ?? "setup"}</span>
          </li>
        ))}
      </ul>
    );
  } else if (section === "permissions") {
    const { data } = await supabase
      .from("role_permission_events")
      .select("id, role, added, removed, changed_by_email, changed_at")
      .order("changed_at", { ascending: false })
      .limit(LIMIT);
    body = (
      <ul className="flex flex-col gap-1 text-sm">
        {(data ?? []).map((event) => (
          <li key={event.id}>
            <span className="text-muted">{minute(event.changed_at)}</span> <span className="font-mono">{event.role}</span>
            {event.added.length > 0 && <> gained {event.added.join(", ")}</>}
            {event.added.length > 0 && event.removed.length > 0 && ";"}
            {event.removed.length > 0 && <> lost {event.removed.join(", ")}</>}
            <span className="text-muted"> by {event.changed_by_email ?? "the system"}</span>
          </li>
        ))}
      </ul>
    );
  } else {
    // Alerts are addressed to federation.notifications; a reader without it sees none (RLS).
    const { data } = await supabase
      .from("federation_alerts")
      .select("id, kind, domain, node_name, raised_at, resolved_at")
      .order("raised_at", { ascending: false })
      .limit(LIMIT);
    body = (
      <ul className="flex flex-col gap-1 text-sm">
        {(data ?? []).map((alert) => (
          <li key={alert.id}>
            <span className="text-muted">{minute(alert.raised_at)}</span>{" "}
            {alert.kind === "first_contact" ? "First contact from" : "Node UUID changed at"} <span className="font-mono">{alert.domain}</span>
            <span className="text-muted">{alert.resolved_at === null ? " — open" : ` — dismissed ${minute(alert.resolved_at)}`}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-muted mt-1 text-sm">The latest {LIMIT} entries of each record. Nothing here can be edited.</p>
      </header>
      <nav className="flex flex-wrap gap-4 text-sm">
        {(Object.entries(SECTIONS) as [Section, string][]).map(([key, label]) =>
          key === section ? (
            <span key={key} className="font-semibold">
              {label}
            </span>
          ) : (
            <Link key={key} href={`/activity?show=${key}`} className="underline-offset-4 hover:underline">
              {label}
            </Link>
          ),
        )}
      </nav>
      {body}
    </main>
  );
}
