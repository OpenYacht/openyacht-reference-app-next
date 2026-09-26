import { createHash } from "node:crypto";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import { IdentityConfigError, parseNodeIdentity, WELL_KNOWN_PATH } from "@/federation";
import { requireSession } from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { userClient } from "@/lib/supabase/server";
import { KeyRotation } from "./keys/key-rotation";
import { SyncSchedule } from "./schedule/sync-schedule";

interface SyncScheduleStatus {
  minute: number;
  job_active: boolean;
  registered_at: string;
  secret_sha256: string;
  last_requested_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_timed_out: boolean | null;
}

const utc = (timestamp: string) => `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** What became of the job's last call, as far as pg_net still remembers it. */
function lastOutcome(status: SyncScheduleStatus): string {
  if (status.last_requested_at === null) return "Not called yet.";
  const when = utc(status.last_requested_at);
  if (status.last_timed_out) return `${when}: timed out.`;
  if (status.last_error !== null) return `${when}: ${status.last_error}`;
  if (status.last_status_code !== null) return `${when}: HTTP ${status.last_status_code}.`;
  // In flight, or older than the six hours pg_net keeps responses for.
  return `${when}: no answer recorded.`;
}

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  const supabase = await userClient();

  // Both reads run as the signed-in user. What comes back is decided by the
  // RLS policies, not by this page: key metadata is visible to a super_admin
  // only, so for anyone else `keys` is simply empty.
  const superAdmin = session.role === "super_admin";
  const [{ data: node }, { data: keys }, schedule] = await Promise.all([
    supabase.from("node_settings").select("node_uuid, identity_domain, identity_mode, setup_completed_at").maybeSingle(),
    supabase.from("federation_keys").select("key_id, status, created_at, overlap_ends_at, rotation_note").order("id", { ascending: false }),
    // The function refuses anyone else, so only a super admin asks.
    superAdmin ? supabase.rpc("sync_schedule_status").maybeSingle<SyncScheduleStatus>() : null,
  ]);
  const syncStatus = schedule?.data ?? null;
  const secret = optionalEnv("INTERNAL_API_SECRET");
  const secretChanged =
    syncStatus !== null && (secret === undefined || createHash("sha256").update(secret).digest("hex") !== syncStatus.secret_sha256);

  let identityProblems: string[] = [];
  try {
    parseNodeIdentity(process.env);
  } catch (error) {
    if (!(error instanceof IdentityConfigError)) throw error;
    identityProblems = error.problems;
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">This node</h1>

      {session.role === null ? (
        <Card>
          <CardHeader>
            <CardTitle>No role assigned</CardTitle>
            <CardDescription>This account is signed in but holds no role. Ask a super admin to assign one.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
              <CardDescription>What this node publishes about itself to partners.</CardDescription>
            </CardHeader>
            <CardContent>
              {identityProblems.length > 0 && (
                <ul className="text-danger mb-4 list-disc pl-5 text-sm">
                  {identityProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted">Identity domain</dt>
                <dd className="font-mono">{node?.identity_domain}</dd>
                <dt className="text-muted">Node UUID</dt>
                <dd className="font-mono">{node?.node_uuid}</dd>
                <dt className="text-muted">Mode</dt>
                <dd>{node?.identity_mode === "production" ? "Real node" : "Trial — disposable identity"}</dd>
                <dt className="text-muted">Discovery document</dt>
                {/* Plain text, not a link: it answers only on the identity domain. */}
                <dd className="font-mono break-all">
                  https://{node?.identity_domain}
                  {WELL_KNOWN_PATH}
                </dd>
              </dl>
            </CardContent>
          </Card>

          {superAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>Scheduled sync</CardTitle>
                <CardDescription>Partners&apos; listings are fetched once an hour by pg_cron in the database.</CardDescription>
              </CardHeader>
              <CardContent>
                {schedule?.error ? (
                  <p className="text-danger text-sm">The schedule could not be read: {schedule.error.message}</p>
                ) : syncStatus === null ? (
                  <p className="text-sm">Not scheduled. Copies are refreshed only when someone runs a sync by hand.</p>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                    <dt className="text-muted">Runs</dt>
                    <dd className="flex items-center gap-3">
                      Every hour at {String(syncStatus.minute).padStart(2, "0")} minutes past
                      {!syncStatus.job_active && <Chip color="danger">job missing</Chip>}
                    </dd>
                    <dt className="text-muted">Last call</dt>
                    <dd>{lastOutcome(syncStatus)}</dd>
                    <dt className="text-muted">Registered</dt>
                    <dd>{utc(syncStatus.registered_at)}</dd>
                  </dl>
                )}
                {secretChanged && (
                  <p className="text-danger mt-4 text-sm">
                    This server&apos;s INTERNAL_API_SECRET is not the one the job sends, so the sync route will refuse it. Register again.
                  </p>
                )}
                <SyncSchedule registered={syncStatus !== null} />
              </CardContent>
            </Card>
          )}

          {superAdmin && (
            <Card>
              <CardHeader>
                <CardTitle>Signing keys</CardTitle>
                <CardDescription>Ed25519. Private keys are held in Supabase Vault and are never shown.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {(keys ?? []).map((key) => (
                    <li key={key.key_id} className="flex items-center gap-3">
                      <span className="font-mono">{key.key_id}</span>
                      <Chip>{key.status}</Chip>
                      <span className="text-muted">{new Date(key.created_at).toISOString().slice(0, 10)}</span>
                      {key.overlap_ends_at !== null && (
                        <span className="text-muted">
                          published until {new Date(key.overlap_ends_at).toISOString().slice(0, 16).replace("T", " ")} UTC
                        </span>
                      )}
                      {key.rotation_note !== null && <span className="text-muted">— {key.rotation_note}</span>}
                    </li>
                  ))}
                </ul>
                <KeyRotation />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
