import { Alert, AlertContent, AlertDescription, AlertTitle, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@heroui/react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { toCopy } from "@/lib/federation/repositories";
import { descriptionSanitiser } from "@/lib/federation/sanitiser";
import { userClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export default async function CopyPage({ params }: PageProps<"/copies/[id]">) {
  await requireSession();
  const { id } = await params;
  const canonicalUri = Buffer.from(id, "base64url").toString("utf8");

  // Read as the signed-in user: RLS decides whether this account sees copies at all.
  const { data } = await (await userClient()).from("listing_copies").select("*").eq("canonical_uri", canonicalUri).maybeSingle();
  if (data === null) notFound();
  const copy = toCopy(data);
  if (copy.payload === null) notFound();

  const listing = record(copy.payload.listing);
  const vessel = record(copy.payload.vessel);
  const usage = record(copy.payload.usage);
  const price = record(listing.price);
  const location = record(listing.location);
  const descriptions = Array.isArray(copy.payload.descriptions) ? copy.payload.descriptions.map(record) : [];

  return (
    <main className="flex flex-col gap-6">
      <header>
        <Link href="/copies" className="text-muted text-sm underline-offset-4 hover:underline">
          ← Partner listings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{text(listing.name) ?? "Unnamed"}</h1>
        <p className="text-muted text-sm">
          {[text(record(vessel.builder).name), text(record(vessel.model).name), vessel.year_built].filter(Boolean).join(" · ")}
        </p>
        {/* ID-10: the authority's attribution terms travel with the listing wherever it is shown. */}
        {usage.attribution_required === true && text(usage.attribution_text) !== null && (
          <p className="mt-2 text-sm italic">{text(usage.attribution_text)}</p>
        )}
      </header>

      {copy.inConflict && (
        <Alert status="danger">
          <AlertContent>
            <AlertTitle>Two authorities list this vessel</AlertTitle>
            <AlertDescription>
              Another partner&apos;s live listing carries the same hull or IMO number. Both copies are kept and neither is displayed until a person
              has looked: this is usually a mandate changing hands, or a genuine dispute.
            </AlertDescription>
          </AlertContent>
        </Alert>
      )}
      {copy.displayState === "held" && copy.heldReasons.length > 0 && (
        <Alert status="warning">
          <AlertContent>
            <AlertTitle>Held — not displayed</AlertTitle>
            <AlertDescription>{copy.heldReasons.join(" ")}</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Listing</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Type</dt>
            <dd>{copy.type}</dd>
            <dt className="text-muted">Status</dt>
            <dd>{copy.status}</dd>
            <dt className="text-muted">Price</dt>
            <dd>
              {price.on_application === true
                ? "On application"
                : text(price.amount) !== null
                  ? `${text(price.amount)} ${text(price.currency) ?? ""}`
                  : copy.type === "charter"
                    ? "See charter rates"
                    : "Withheld by the authority"}
            </dd>
            <dt className="text-muted">Location</dt>
            <dd>{text(location.display) ?? "—"}</dd>
          </dl>
        </CardContent>
      </Card>

      {descriptions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            {descriptions.map((description, index) => (
              <section key={index}>
                <h3 className="text-muted mb-1 text-xs uppercase">{text(description.section) ?? "Section"}</h3>
                {/* Sanitised when it was received, and again here: this markup was written by another organisation (LS-5). */}
                <div
                  className="[&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
                  dangerouslySetInnerHTML={{ __html: descriptionSanitiser.sanitise(text(description.content) ?? "") }}
                />
              </section>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Provenance</CardTitle>
          <CardDescription>
            This is a copy. {copy.provenance.authority} is the authority for the listing and the only node that can change it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Canonical URI</dt>
            {/* Plain text, never a link: it is an identifier, and dereferences only for signed partners. */}
            <dd className="font-mono break-all">{copy.provenance.canonical}</dd>
            <dt className="text-muted">Authority</dt>
            <dd className="font-mono">{copy.provenance.authority}</dd>
            <dt className="text-muted">Received</dt>
            <dd>{copy.provenance.received_at}</dd>
            <dt className="text-muted">Verified</dt>
            <dd>{copy.provenance.signature_verified ? "Yes — received from the authority's own domain over verified TLS" : "No"}</dd>
            <dt className="text-muted">Authority&apos;s last change</dt>
            <dd>{copy.updatedAt}</dd>
            {copy.unknownSlugs.length > 0 && (
              <>
                <dt className="text-muted">Unknown registry slugs</dt>
                <dd>
                  <span className="font-mono">{copy.unknownSlugs.join(", ")}</span> — the vendored registries are probably out of date.
                </dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage terms</CardTitle>
          <CardDescription>Set by the authority. They bind every use of this listing and its media.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            {(["display", "attribution_required", "marketing_materials", "ai_indexing", "expires_with_listing"] as const).map((term) => (
              <div key={term} className="contents">
                <dt className="text-muted">{term.replaceAll("_", " ")}</dt>
                <dd>{usage[term] === true ? "yes" : "no"}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </main>
  );
}
