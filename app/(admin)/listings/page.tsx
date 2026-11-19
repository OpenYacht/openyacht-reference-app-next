import { Chip } from "@heroui/react";
import Link from "next/link";
import { IndexFilters, IndexPagination, IndexTabs, STATUS_LABEL } from "@/components/listing-index";
import { can, requireSession } from "@/lib/auth/session";
import { containsPattern, OWN_LISTING_VIEWS, pageRange, parseIndexQuery, statusesOf } from "@/lib/listings/index-query";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PATH = "/listings";
const STATUS_COLOR = { draft: "default", active: "success", under_offer: "warning", sold: "default", withdrawn: "default" } as const;
const AUDIENCE = { everyone: "every verified partner", selected: "selected partners", none: "nobody" } as const;

export default async function ListingsPage({ searchParams }: PageProps<"/listings">) {
  const session = await requireSession();
  if (session.role === null) return <p className="text-muted text-sm">This account holds no role.</p>;
  const query = parseIndexQuery(await searchParams, OWN_LISTING_VIEWS);
  const view = OWN_LISTING_VIEWS.find((candidate) => candidate.key === query.view) ?? OWN_LISTING_VIEWS[0];

  // Read as the signed-in user: a broker's query returns their own listings only, because the policy says so.
  const supabase = await userClient();

  // The search covers the vessel's builder and model as well as the listing's
  // name. Those live on `vessels`, and one PostgREST `or` cannot span two
  // tables, so the matching vessels are found first.
  const pattern = containsPattern(query.q);
  let vesselIds: number[] = [];
  if (query.q !== "") {
    const { data } = await supabase.from("vessels").select("id").or(`builder_name.ilike.${pattern},model_name.ilike.${pattern}`);
    vesselIds = (data ?? []).map((vessel) => vessel.id as number);
  }

  // Every filter except status and paging, so the tab counts and the page agree.
  const filtered = (columns: string, statuses: readonly string[], head = false) => {
    let request = supabase
      .from("listings")
      .select(columns, { count: "exact", head })
      .in("status", [...statuses]);
    if (query.type !== null) request = request.eq("listing_type", query.type);
    if (query.q !== "") {
      request = request.or(vesselIds.length > 0 ? `name.ilike.${pattern},vessel_id.in.(${vesselIds.join(",")})` : `name.ilike.${pattern}`);
    }
    return request;
  };

  const [page, ...tabCounts] = await Promise.all([
    filtered(
      "id, name, listing_type, status, audience, price_amount, price_currency, price_on_application, federation_updated_at, vessels(builder_name, model_name, year_built)",
      query.status !== null ? [query.status] : view.statuses,
    )
      .order("federation_updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(...pageRange(query.page)),
    ...OWN_LISTING_VIEWS.map((tab) => filtered("id", statusesOf(OWN_LISTING_VIEWS, tab.key), true)),
  ]);
  const counts = Object.fromEntries(OWN_LISTING_VIEWS.map((tab, index) => [tab.key, tabCounts[index]?.count ?? 0]));
  const listings = (page.data ?? []) as unknown as {
    id: number;
    name: string;
    listing_type: string;
    status: keyof typeof STATUS_COLOR;
    audience: keyof typeof AUDIENCE;
    price_amount: string | null;
    price_currency: string | null;
    price_on_application: boolean;
    vessels: { builder_name: string | null; model_name: string | null; year_built: number | null } | null;
  }[];

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Listings</h1>
          <p className="text-muted mt-1 text-sm">The listings this node is the authority for. Partners receive them from here and nowhere else.</p>
        </div>
        {can(session, "listings.manage", "listings.manage_own") && (
          <div className="flex gap-3 text-sm font-medium">
            <Link href="/listings/new?type=sale" className="bg-accent text-accent-foreground rounded-full px-4 py-2">
              New sale listing
            </Link>
            <Link href="/listings/new?type=charter" className="border-border rounded-full border px-4 py-2">
              New charter listing
            </Link>
          </div>
        )}
      </header>

      <IndexTabs path={PATH} query={query} views={OWN_LISTING_VIEWS} counts={counts} />
      <IndexFilters path={PATH} query={query} view={view} />

      {listings.length === 0 ? (
        <p className="text-muted text-sm">
          {query.type !== null || query.status !== null || query.q !== ""
            ? "Nothing matches these filters."
            : { live: "No live listings.", drafts: "No drafts.", past: "No sold or withdrawn listings." }[view.key]}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted border-border border-b text-xs uppercase">
              <tr>
                <th className="py-2 pr-4 font-medium">Listing</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Price</th>
                <th className="py-2 font-medium">Shared with</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <tr key={listing.id} className="border-border border-b align-top">
                  <td className="py-3 pr-4">
                    <Link href={`/listings/${listing.id}`} className="font-medium underline-offset-4 hover:underline">
                      {listing.name}
                    </Link>
                    <div className="text-muted text-xs">
                      {[listing.listing_type, listing.vessels?.builder_name, listing.vessels?.model_name, listing.vessels?.year_built]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <Chip color={STATUS_COLOR[listing.status]}>{STATUS_LABEL[listing.status] ?? listing.status}</Chip>
                  </td>
                  <td className="py-3 pr-4">
                    {listing.listing_type === "charter"
                      ? "—"
                      : listing.price_on_application
                        ? "On application"
                        : listing.price_amount
                          ? `${listing.price_amount} ${listing.price_currency}`
                          : "—"}
                  </td>
                  <td className="py-3">
                    {listing.status === "draft" ? (
                      <span className="text-muted">not distributed — a draft</span>
                    ) : listing.status === "sold" || listing.status === "withdrawn" ? (
                      // An ended listing reaches partners only as a tombstone (API-3).
                      <span className="text-muted">ended — partners hold a tombstone</span>
                    ) : (
                      AUDIENCE[listing.audience]
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <IndexPagination path={PATH} query={query} total={page.count ?? 0} />
    </main>
  );
}
