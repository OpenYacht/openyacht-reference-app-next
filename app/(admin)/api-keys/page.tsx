import { Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";
import { CreateApiKeyForm, RevokeApiKeyForm } from "./api-key-forms";

export const dynamic = "force-dynamic";

const minute = (timestamp: string | null) =>
  timestamp === null ? "never" : `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function ApiKeysPage() {
  await requirePermission("api-keys.manage");
  const { data: keys } = await (
    await userClient()
  )
    .from("api_keys")
    .select("id, name, prefix, scopes, rate_per_minute, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });

  return (
    <main className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-muted mt-1 text-sm">
          Keys for the data API, which serves this node&apos;s own listings and the partner listings it displays to your own websites and feeds:{" "}
          <span className="font-mono">GET /api/v1/yachts</span> and <span className="font-mono">/api/v1/yachts/{"{key}"}</span>. It is not how
          partners reach this node; they use federation, and need no key.
        </p>
      </header>

      {(keys ?? []).length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Limit</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(keys ?? []).map((key) => (
                <tr key={key.id} className="border-border border-b align-top">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{key.name}</div>
                    <div className="text-muted font-mono text-xs">{key.prefix}…</div>
                  </td>
                  <td className="py-3 pr-4">{key.rate_per_minute}/min</td>
                  <td className="py-3 pr-4">{minute(key.last_used_at)}</td>
                  <td className="py-3">{key.revoked_at === null ? <RevokeApiKeyForm keyId={key.id} /> : <Chip>revoked</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New key</CardTitle>
          <CardDescription>Shown once. Only its digest is stored.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateApiKeyForm />
        </CardContent>
      </Card>
    </main>
  );
}
