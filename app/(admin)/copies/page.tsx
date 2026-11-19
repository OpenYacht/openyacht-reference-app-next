import { Chip } from "@heroui/react";
import Link from "next/link";
import { partnerFreshness } from "@/federation";
import { IndexFilters, IndexPagination, IndexTabs, STATUS_LABEL } from "@/components/listing-index";
import { requireSession } from "@/lib/auth/session";
import { toCopy } from "@/lib/federation/repositories";
import { containsPattern, pageRange, parseIndexQuery, PARTNER_LISTING_VIEWS, statusesOf } from "@/lib/listings/index-query";
import { serviceClient } from "@/lib/supabase/service";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PATH = "/copies";

const text = (value: unknown) => (typeof value === "string" ? value : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const day = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 10);

export default async function CopiesPage({ searchParams }: PageProps<"/copies">) {
  const session = await requireSession();
  if (session.role === null) return <p className="text-muted text-sm">This account holds no role.</p>;
  const query = parseIndexQuery(await searchParams, PARTNER_LISTING_VIEWS);
  const view = PARTNER_LISTING_VIEWS.find((candidate) => candidate.key === query.view) ?? PARTNER_LISTING_VIEWS[0];
  const past = view.key === "past";

  // Copies are read as the signed-in user, under RLS. Partner names and sync
  // times are federation configuration a non-admin cannot read, but staleness
  // must be shown to everyone who sees a listing (FP-15), and the partner
  // filter needs names — so just those columns are read with the service role.
  const supabase = await userClient();

  // An ended copy holds no data (ID-7), so there is nothing to search on the
  // past tab; the search applies to live copies only.
  const pattern = containsPattern(query.q);
  const search = query.q !== "" && !past;
  const searchesTab = (key: string) => query.q !== "" && key !== "past";

  // Every filter except status and paging, so the tab counts and the page agree.
  const filtered = (statuses: readonly string[], applySearch: boolean, head = false) => {
    let request = supabase
      .from("listing_copies")
      .select("*", { count: "exact", head })
      .in("status", [...statuses]);
    if (query.type !== null) request = request.eq("listing_type", query.type);
    if (query.partner !== null) request = request.eq("partner_id", query.partner);
    if (applySearch) {
      request = request.or(
        [
          `payload->listing->>name.ilike.${pattern}`,
          `payload->vessel->builder->>name.ilike.${pattern}`,
          `payload->vessel->model->>name.ilike.${pattern}`,
        ].join(","),
      );
    }
    return request;
  };

  const [page, partnerRows, ...tabCounts] = await Promise.all([
    filtered(query.status !== null ? [query.status] : view.statuses, search)
      .order("last_received_at", { ascending: false })
      .order("canonical_uri")
      .range(...pageRange(query.page)),
    // Only partners that have sent this node something are worth filtering by.
    serviceClient().from("federation_partners").select("id, node_name, domain, last_ok_at, created_at, listing_copies(count)"),
    ...PARTNER_LISTING_VIEWS.map((tab) => filtered(statusesOf(PARTNER_LISTING_VIEWS, tab.key), searchesTab(tab.key), true)),
  ]);
  const counts = Object.fromEntries(PARTNER_LISTING_VIEWS.map((tab, index) => [tab.key, tabCounts[index]?.count ?? 0]));

  const now = new Date();
  const partners = new Map(
    (partnerRows.data ?? []).map((row) => [
      String(row.id),
      {
        name: (row.node_name as string | null) ?? (row.domain as string),
        copies: (row.listing_copies as { count: number }[] | null)?.[0]?.count ?? 0,
        freshness: partnerFreshness(
          { lastOkAt: row.last_ok_at === null ? null : new Date(row.last_ok_at), createdAt: new Date(row.created_at) },
          now,
        ),
      },
    ]),
  );
  const partnerOptions = [...partners]
    .filter(([, partner]) => partner.copies > 0)
    .map(([id, partner]) => ({ id, label: partner.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const copies = (page.data ?? []).map(toCopy);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Partner listings</h1>
        <p className="text-muted mt-1 text-sm">
          Copies of listings other nodes are the authority for. They are never edited here and never served onward as this node&apos;s own.
        </p>
      </header>

      <IndexTabs path={PATH} query={query} views={PARTNER_LISTING_VIEWS} counts={counts} />
      <IndexFilters path={PATH} query={query} view={view} partners={partnerOptions} searchable={!past} />
      {past && (
        <p className="text-muted text-sm">
          Their authorities have ended these listings. Only the tombstone is kept — which listing, from whom, and when it ended — never its data.
        </p>
      )}

      {copies.length === 0 ? (
        <p className="text-muted text-sm">
          {query.type !== null || query.status !== null || query.partner !== null || search
            ? "Nothing matches these filters."
            : past
              ? "No partner listing has ended."
              : "Nothing has been synchronised yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Listing</th>
                <th className="py-2 pr-4 font-medium">Authority</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">{past ? "Ended" : "Display"}</th>
              </tr>
            </thead>
            <tbody>
              {copies.map((copy) => {
                const partner = partners.get(copy.partnerId);
                const listing = record(copy.payload?.listing);
                const vessel = record(copy.payload?.vessel);
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
                      <div className="text-muted text-xs">
                        {[copy.type, text(record(vessel.builder).name), text(record(vessel.model).name), vessel.year_built]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td className="py-3 pr-4">{partner?.name ?? copy.provenance.authority}</td>
                    <td className="py-3 pr-4">{STATUS_LABEL[copy.status] ?? copy.status}</td>
                    <td className="py-3">
                      {ended ? (
                        <span className="text-muted">{day(copy.tombstonedAt as string)}</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {copy.inConflict && copy.conflictReviewedAt === null ? (
                            <Chip color="danger">held — vessel claimed by two authorities</Chip>
                          ) : copy.displayState === "published" && partner?.freshness !== "hidden" ? (
                            <Chip color="success">displayed</Chip>
                          ) : (
                            <Chip color="warning">held</Chip>
                          )}
                          {partner?.freshness === "stale" && <Chip color="danger">stale</Chip>}
                          {partner?.freshness === "hidden" && <Chip color="danger">partner unreachable</Chip>}
                          {copy.unknownSlugs.length > 0 && <Chip>registry out of date</Chip>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <IndexPagination path={PATH} query={query} total={page.count ?? 0} />
    </main>
  );
}
