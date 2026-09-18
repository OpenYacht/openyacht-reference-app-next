import { Alert, AlertContent, AlertDescription, AlertTitle, Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { canonicalUri, parseNodeIdentity } from "@/federation";
import { hasRole, requireSession } from "@/lib/auth/session";
import { builderChoices, categoryChoices } from "@/lib/federation/registry";
import { userClient } from "@/lib/supabase/server";
import { updateListingAction } from "../actions";
import { ListingForm } from "../listing-form";
import { SharingForm, StatusControls } from "./listing-controls";

export const dynamic = "force-dynamic";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

export default async function ListingPage({ params }: PageProps<"/listings/[id]">) {
  const session = await requireSession();
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const supabase = await userClient();

  // As the signed-in user: a broker who asks for someone else's listing gets nothing back.
  const { data: listing } = await supabase
    .from("listings")
    .select("*, vessels(*), price_history(id, amount, currency, changed_at), listing_shares(partner_id)")
    .eq("id", id)
    .maybeSingle();
  if (listing === null) notFound();
  const { data: partners } = await supabase.rpc("shareable_partners");

  const vessel = record(listing.vessels);
  const specifications = record(listing.specifications);
  const charter = record(listing.charter);
  const rate = record((Array.isArray(charter.rates) ? charter.rates : [])[0]);
  const broker = record((listing.brokers as unknown[])[0]);
  const overview = (listing.descriptions as { section: string; content: string }[]).find((description) => description.section === "overview");
  const history = [...(listing.price_history as { id: number; amount: string; currency: string; changed_at: string }[])].sort((a, b) => b.id - a.id);
  const canEdit = hasRole(session, "broker");
  const ended = listing.status === "sold" || listing.status === "withdrawn";

  return (
    <main className="flex flex-col gap-6">
      <header>
        <Link href="/listings" className="text-muted text-sm underline-offset-4 hover:underline">
          ← Listings
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{listing.name}</h1>
          <Chip color={listing.status === "active" ? "success" : listing.status === "under_offer" ? "warning" : "default"}>
            {String(listing.status).replace("_", " ")}
          </Chip>
          <Chip>{listing.listing_type}</Chip>
        </div>
        {/* An identifier, not a link: it dereferences only for signed partners. */}
        <p className="text-muted mt-1 font-mono text-xs break-all">{canonicalUri(parseNodeIdentity(process.env).domain, listing.uuid)}</p>
      </header>

      {listing.status === "draft" && (
        <Alert status="accent">
          <AlertContent>
            <AlertTitle>A draft — not distributed</AlertTitle>
            <AlertDescription>No partner can see a draft, whatever its sharing says. Its price history starts when it goes active.</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>draft → active ⇄ under offer → sold or withdrawn. Sold and withdrawn are final.</CardDescription>
          </CardHeader>
          <CardContent>
            <StatusControls listingId={listing.id} status={listing.status} canDelete={hasRole(session, "editor")} />
          </CardContent>
        </Card>
      )}

      {canEdit && !ended && (
        <Card>
          <CardHeader>
            <CardTitle>Sharing</CardTitle>
            <CardDescription>
              Which partners receive this listing. Taking it away from a partner sends that partner a withdrawal; it does not change the listing, and
              no other partner is told anything. Which fields a partner sees is set on the partner.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SharingForm
              listingId={listing.id}
              audience={listing.audience}
              shared={(listing.listing_shares as { partner_id: number }[]).map((share) => share.partner_id)}
              partners={(partners ?? []) as { id: number; node_name: string; domain: string }[]}
            />
          </CardContent>
        </Card>
      )}

      {listing.listing_type === "sale" && (
        <Card>
          <CardHeader>
            <CardTitle>Price history</CardTitle>
            <CardDescription>Recorded automatically, and never edited. Sent only to partners granted price history.</CardDescription>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-muted text-sm">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <span className="font-mono">
                      {entry.amount} {entry.currency}
                    </span>{" "}
                    <span className="text-muted">from {new Date(entry.changed_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {canEdit && !ended ? (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>Saving a change stamps the listing, and partners who can see it pick the change up on their next poll.</CardDescription>
          </CardHeader>
          <CardContent>
            <ListingForm
              action={updateListingAction}
              submitLabel="Save changes"
              builders={builderChoices}
              categories={categoryChoices}
              values={{
                listingId: listing.id,
                listingType: listing.listing_type,
                name: listing.name,
                summary: listing.summary,
                condition: listing.condition,
                builder: text(vessel.builder_name),
                model: text(vessel.model_name),
                yearBuilt: num(vessel.year_built),
                loaM: vessel.loa_m === null || vessel.loa_m === undefined ? null : Number(vessel.loa_m),
                hin: text(vessel.hin),
                imo: text(vessel.imo),
                powerOrSail: text(specifications.power_or_sail),
                category: text(record(specifications.category).slug),
                beamM: num(specifications.beam_m),
                cabins: num(specifications.cabins),
                sleeps: num(specifications.sleeps),
                priceAmount: listing.price_amount,
                priceCurrency: listing.price_currency,
                priceOnApplication: listing.price_on_application,
                locationDisplay: listing.location_display,
                locationCity: listing.location_city,
                locationCountry: listing.location_country,
                locationMarina: listing.location_marina,
                overview: overview?.content ?? null,
                brokerName: text(broker.name),
                brokerEmail: text(broker.email),
                brokerPhone: text(broker.phone),
                summerBasePort: text(charter.summer_base_port),
                winterBasePort: text(charter.winter_base_port),
                rateMin: text(rate.amount_min),
                rateMax: text(rate.amount_max),
                rateCurrency: text(rate.currency),
              }}
            />
          </CardContent>
        </Card>
      ) : (
        ended && <p className="text-muted text-sm">An ended listing is no longer edited. It stays dereferenceable for partners for twelve months.</p>
      )}
    </main>
  );
}
