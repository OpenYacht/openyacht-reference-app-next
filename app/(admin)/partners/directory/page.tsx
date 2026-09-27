import { Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import Link from "next/link";
import { parseNodeDirectory, parseNodeIdentity } from "@/federation";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";
import vendored from "@/protocol/registry/nodes.json";
import { ListingRequestForm } from "./listing-request-form";

export const dynamic = "force-dynamic";

// FP-16: the directory is a phonebook. Being in it proves nothing and being
// absent means nothing; a node found here is added like any other domain,
// from its own well-known document. The copy read is the vendored one —
// nothing is fetched at request time.
export default async function DirectoryPage() {
  await requirePermission("federation.manage");
  const directory = parseNodeDirectory(vendored);
  const own = parseNodeIdentity(process.env).domain;
  const { data: partners } = await (await userClient()).from("federation_partners").select("id, domain, trust_level");
  const partnerOf = new Map((partners ?? []).map((partner) => [partner.domain as string, partner]));

  return (
    <main className="flex flex-col gap-8">
      <header>
        <p className="text-sm">
          <Link href="/partners" className="underline-offset-4 hover:underline">
            Partners
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Node directory</h1>
        <p className="text-muted mt-1 text-sm">
          Nodes that have asked to be listed, from the copy vendored with this release (version {directory.version}). A listing is not an endorsement
          and verifies nothing; a node found here is checked like any other, from its own domain, and needs your approval like any other. Nodes that
          are not listed are no less real.
        </p>
      </header>

      {directory.entries.length === 0 ? (
        <p className="text-muted text-sm">This copy of the directory lists no nodes yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Node</th>
                <th className="py-2 pr-4 font-medium">Country</th>
                <th className="py-2 pr-4 font-medium">Listed</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {directory.entries.map((entry) => {
                const partner = partnerOf.get(entry.domain);
                return (
                  <tr key={entry.domain} className="border-border border-b">
                    <td className="py-3 pr-4">
                      <div className="font-medium">{entry.name}</div>
                      <div className="text-muted font-mono text-xs">{entry.domain}</div>
                      {entry.website !== null && (
                        <a href={entry.website} className="text-xs underline underline-offset-4" rel="noopener noreferrer" target="_blank">
                          {entry.website}
                        </a>
                      )}
                    </td>
                    <td className="py-3 pr-4">{entry.country ?? "—"}</td>
                    <td className="py-3 pr-4">{entry.listedAt ?? "—"}</td>
                    <td className="py-3">
                      {entry.domain === own ? (
                        <Chip>this node</Chip>
                      ) : partner !== undefined ? (
                        <Link href={`/partners/${partner.id}`} className="underline underline-offset-4">
                          Partner ({partner.trust_level})
                        </Link>
                      ) : (
                        <Link href={`/partners?add=${encodeURIComponent(entry.domain)}`} className="underline underline-offset-4">
                          Add as a partner
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {directory.skipped > 0 && <p className="text-muted text-sm">{directory.skipped} malformed entries were left out.</p>}

      <Card>
        <CardHeader>
          <CardTitle>This node in the directory</CardTitle>
          <CardDescription>
            Listing is optional. The directory accepts a request signed with this node&apos;s signing key, which proves you control{" "}
            <span className="font-mono">{own}</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListingRequestForm listed={directory.entries.some((entry) => entry.domain === own)} />
        </CardContent>
      </Card>
    </main>
  );
}
