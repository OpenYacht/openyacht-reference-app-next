import { Chip } from "@heroui/react";
import Link from "next/link";
import { hasRole, requireSession } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const STATUS_COLOR = { draft: "default", active: "success", under_offer: "warning", sold: "default", withdrawn: "default" } as const;
const AUDIENCE = { everyone: "every verified partner", selected: "selected partners", none: "nobody" } as const;

export default async function ListingsPage() {
  const session = await requireSession();
  if (session.role === null) return <p className="text-muted text-sm">This account holds no role.</p>;

  // Read as the signed-in user: a broker's query returns their own listings only, because the policy says so.
  const { data: listings } = await (
    await userClient()
  )
    .from("listings")
    .select(
      "id, name, listing_type, status, audience, price_amount, price_currency, price_on_application, federation_updated_at, vessels(builder_name, model_name, year_built)",
    )
    .order("federation_updated_at", { ascending: false });

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Listings</h1>
          <p className="text-muted mt-1 text-sm">The listings this node is the authority for. Partners receive them from here and nowhere else.</p>
        </div>
        {hasRole(session, "broker") && (
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

      {(listings ?? []).length === 0 ? (
        <p className="text-muted text-sm">No listings yet.</p>
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
              {(listings ?? []).map((listing) => {
                const vessel = (Array.isArray(listing.vessels) ? listing.vessels[0] : listing.vessels) as {
                  builder_name: string | null;
                  model_name: string | null;
                  year_built: number | null;
                } | null;
                return (
                  <tr key={listing.id} className="border-border border-b align-top">
                    <td className="py-3 pr-4">
                      <Link href={`/listings/${listing.id}`} className="font-medium underline-offset-4 hover:underline">
                        {listing.name}
                      </Link>
                      <div className="text-muted text-xs">
                        {[listing.listing_type, vessel?.builder_name, vessel?.model_name, vessel?.year_built].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <Chip color={STATUS_COLOR[listing.status as keyof typeof STATUS_COLOR]}>{String(listing.status).replace("_", " ")}</Chip>
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
                      ) : (
                        AUDIENCE[listing.audience as keyof typeof AUDIENCE]
                      )}
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
