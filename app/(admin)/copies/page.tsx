import { Chip } from "@heroui/react";
import Link from "next/link";
import { partnerFreshness } from "@/federation";
import { requireSession } from "@/lib/auth/session";
import { toCopy } from "@/lib/federation/repositories";
import { serviceClient } from "@/lib/supabase/service";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const text = (value: unknown) => (typeof value === "string" ? value : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export default async function CopiesPage({ searchParams }: PageProps<"/copies">) {
  const session = await requireSession();
  if (session.role === null) return <p className="text-muted text-sm">This account holds no role.</p>;
  const { partner: partnerFilter } = await searchParams;

  // Copies are read as the signed-in user, under RLS. Partner names and sync
  // times are federation configuration a non-admin cannot read, but staleness
  // must be shown to everyone who sees a listing (FP-15) — so just those three
  // columns are read with the service role.
  const supabase = await userClient();
  let query = supabase.from("listing_copies").select("*").order("last_received_at", { ascending: false }).limit(200);
  if (typeof partnerFilter === "string" && /^\d+$/.test(partnerFilter)) query = query.eq("partner_id", partnerFilter);
  const [{ data: rows }, { data: partnerRows }] = await Promise.all([
    query,
    serviceClient().from("federation_partners").select("id, node_name, domain, last_ok_at, created_at"),
  ]);

  const now = new Date();
  const partners = new Map(
    (partnerRows ?? []).map((row) => [
      String(row.id),
      {
        name: row.node_name as string,
        freshness: partnerFreshness(
          { lastOkAt: row.last_ok_at === null ? null : new Date(row.last_ok_at), createdAt: new Date(row.created_at) },
          now,
        ),
      },
    ]),
  );
  const copies = (rows ?? []).map(toCopy);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Partner listings</h1>
        <p className="text-muted mt-1 text-sm">
          Copies of listings other nodes are the authority for. They are never edited here and never served onward as this node&apos;s own.
        </p>
      </header>

      {copies.length === 0 ? (
        <p className="text-muted text-sm">Nothing has been synchronised yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Listing</th>
                <th className="py-2 pr-4 font-medium">Authority</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">Display</th>
              </tr>
            </thead>
            <tbody>
              {copies.map((copy) => {
                const partner = partners.get(copy.partnerId);
                const listing = record(copy.payload?.listing);
                const ended = copy.tombstonedAt !== null;
                return (
                  <tr key={copy.canonicalUri} className="border-border border-b align-top">
                    <td className="py-3 pr-4">
                      {ended ? (
                        <span className="text-muted">Ended listing</span>
                      ) : (
                        <Link
                          href={`/copies/${Buffer.from(copy.canonicalUri).toString("base64url")}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {text(listing.name) ?? "Unnamed"}
                        </Link>
                      )}
                      <div className="text-muted text-xs">{copy.type}</div>
                    </td>
                    <td className="py-3 pr-4">{partner?.name ?? copy.provenance.authority}</td>
                    <td className="py-3 pr-4">{copy.status}</td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        {ended ? (
                          <Chip>ended</Chip>
                        ) : copy.inConflict ? (
                          <Chip color="danger">held — vessel claimed by two authorities</Chip>
                        ) : copy.displayState === "published" && partner?.freshness !== "hidden" ? (
                          <Chip color="success">displayed</Chip>
                        ) : (
                          <Chip color="warning">held</Chip>
                        )}
                        {!ended && partner?.freshness === "stale" && <Chip color="danger">stale</Chip>}
                        {!ended && partner?.freshness === "hidden" && <Chip color="danger">partner unreachable</Chip>}
                        {copy.unknownSlugs.length > 0 && <Chip>registry out of date</Chip>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
