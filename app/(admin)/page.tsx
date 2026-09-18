import { Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import { IdentityConfigError, parseNodeIdentity, WELL_KNOWN_PATH } from "@/federation";
import { requireSession } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  const supabase = await userClient();

  // Both reads run as the signed-in user. What comes back is decided by the
  // RLS policies, not by this page: key metadata is visible to a super_admin
  // only, so for anyone else `keys` is simply empty.
  const [{ data: node }, { data: keys }] = await Promise.all([
    supabase.from("node_settings").select("node_uuid, identity_domain, identity_mode, setup_completed_at").maybeSingle(),
    supabase.from("federation_keys").select("key_id, status, created_at").order("id", { ascending: false }),
  ]);

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

          {session.role === "super_admin" && (
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
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
