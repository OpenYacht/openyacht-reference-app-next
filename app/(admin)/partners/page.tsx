import { Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import Link from "next/link";
import { parseNodeIdentity, partnerFreshness } from "@/federation";
import { requireRole } from "@/lib/auth/session";
import { SupabasePartnerRepository } from "@/lib/federation/repositories";
import { userClient } from "@/lib/supabase/server";
import { AddPartnerForm } from "./add-partner-form";

export const dynamic = "force-dynamic";

const TRUST_COLOR = { verified: "success", provisional: "warning", blocked: "danger" } as const;

export default async function PartnersPage() {
  const session = await requireRole("super_admin");
  const partners = await new SupabasePartnerRepository(await userClient()).list();
  const now = new Date();

  return (
    <main className="flex flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Partners</h1>
        <p className="text-muted mt-1 text-sm">Nodes this one exchanges listings with. Trust is pairwise, and a person approves each partnership.</p>
      </header>

      {partners.length === 0 ? (
        <p className="text-muted text-sm">No partners yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Partner</th>
                <th className="py-2 pr-4 font-medium">Trust</th>
                <th className="py-2 pr-4 font-medium">Last synchronised</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((partner) => {
                const freshness = partnerFreshness(partner, now);
                return (
                  <tr key={partner.id} className="border-border border-b">
                    <td className="py-3 pr-4">
                      <Link href={`/partners/${partner.id}`} className="font-medium underline-offset-4 hover:underline">
                        {partner.nodeName}
                      </Link>
                      <div className="text-muted font-mono text-xs">{partner.domain}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <Chip color={TRUST_COLOR[partner.trustLevel]}>{partner.trustLevel}</Chip>
                    </td>
                    <td className="py-3 pr-4">
                      {partner.lastOkAt === null ? "never" : partner.lastOkAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        {partner.trustLevel === "provisional" && <Chip color="accent">needs your approval</Chip>}
                        {partner.awaitingApproval && <Chip color="warning">awaiting their approval</Chip>}
                        {freshness !== "fresh" && <Chip color="danger">{freshness === "hidden" ? "unreachable — listings hidden" : "stale"}</Chip>}
                        {partner.consecutiveFailures > 0 && <Chip>{partner.consecutiveFailures} failed attempts</Chip>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add a partner</CardTitle>
          <CardDescription>You need only their identity domain. Everything else is read from the node itself.</CardDescription>
        </CardHeader>
        <CardContent>
          <AddPartnerForm nodeName={parseNodeIdentity(process.env).name} contactEmail={session.email ?? ""} />
        </CardContent>
      </Card>
    </main>
  );
}
