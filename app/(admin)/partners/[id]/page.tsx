import { Alert, AlertContent, AlertDescription, AlertTitle, Card, CardContent, CardDescription, CardHeader, CardTitle, Chip } from "@heroui/react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { nextAttemptAt, parseNodeIdentity, partnerFreshness } from "@/federation";
import { requireRole } from "@/lib/auth/session";
import { SupabasePartnerRepository } from "@/lib/federation/repositories";
import { userClient } from "@/lib/supabase/server";
import { FieldGroupsForm, Introduce, PolicyForm, RateLimitForm, RefreshKeys, SyncNow, TrustAndRemoval } from "./partner-actions";
import { DEFAULT_RATE_PER_HOUR } from "@/lib/federation/handlers";

export const dynamic = "force-dynamic";

const when = (value: Date | null) => (value === null ? "never" : `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`);

export default async function PartnerPage({ params }: PageProps<"/partners/[id]">) {
  const session = await requireRole("super_admin");
  const { id } = await params;
  const supabase = await userClient();
  const partners = new SupabasePartnerRepository(supabase);
  const partner = /^\d+$/.test(id) ? await partners.findById(id) : null;
  if (partner === null) notFound();

  // What the partner said when it introduced itself, if it did.
  const { data: received } = await supabase
    .from("federation_partners")
    .select("request_message, request_contact_email, requested_at, first_contact_at, field_groups, rate_per_hour")
    .eq("id", partner.id)
    .maybeSingle();

  const copies = await partners.countCopies(partner.id);
  const freshness = partnerFreshness(partner, new Date());
  const retryAt = nextAttemptAt(partner);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <Link href="/partners" className="text-muted text-sm underline-offset-4 hover:underline">
          ← Partners
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{partner.nodeName}</h1>
        <p className="text-muted font-mono text-sm">{partner.domain}</p>
      </header>

      {(received?.requested_at || received?.first_contact_at) && (
        <Alert status={partner.trustLevel === "provisional" ? "accent" : "default"}>
          <AlertContent>
            <AlertTitle>
              {partner.trustLevel === "provisional" ? "This node is asking to partner with you" : "Partnership request received"}
              {received.requested_at ? ` · ${when(new Date(received.requested_at))}` : ""}
            </AlertTitle>
            <AlertDescription>
              {/* Written by another organisation: rendered as text, never as markup. */}
              {received.request_message ? <span className="block whitespace-pre-wrap">“{received.request_message}”</span> : "It sent no message."}
              {received.request_contact_email && <span className="mt-1 block">Contact: {received.request_contact_email}</span>}
              {partner.trustLevel === "provisional" && (
                <span className="mt-2 block">
                  Its signature verified against the keys its domain serves — that authenticates the server, not the business. Nothing is shared with
                  it until you approve it below. Check the domain is one you recognise.
                </span>
              )}
            </AlertDescription>
          </AlertContent>
        </Alert>
      )}
      {partner.awaitingApproval && (
        <Alert status="warning">
          <AlertContent>
            <AlertTitle>Waiting for their approval</AlertTitle>
            <AlertDescription>
              Their node is reachable and has registered this one, but a person there has not approved it yet. Nothing is wrong; this node keeps
              polling and will pick up the approval by itself.
            </AlertDescription>
          </AlertContent>
        </Alert>
      )}
      {freshness !== "fresh" && (
        <Alert status="danger">
          <AlertContent>
            <AlertTitle>
              {freshness === "hidden" ? "Unreachable for 30 days — listings no longer displayed" : "Stale — not synchronised for 7 days"}
            </AlertTitle>
            <AlertDescription>
              A partner that disappears never sends withdrawals. Its listings are marked stale, and after 30 days they stop being displayed until it
              synchronises again.
            </AlertDescription>
          </AlertContent>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Synchronisation</CardTitle>
          <CardDescription>
            {copies} listing{copies === 1 ? "" : "s"} received · <Link href={`/copies?partner=${partner.id}`}>view</Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Last successful</dt>
            <dd>{when(partner.lastOkAt)}</dd>
            <dt className="text-muted">Last attempt</dt>
            <dd>{when(partner.lastAttemptAt)}</dd>
            <dt className="text-muted">Failed attempts in a row</dt>
            <dd>
              {partner.consecutiveFailures}
              {retryAt !== null && ` — backing off until ${when(retryAt)}`}
            </dd>
            <dt className="text-muted">Polling from</dt>
            <dd className="font-mono">{partner.syncWatermark ?? "the beginning (cold sync)"}</dd>
          </dl>
          <SyncNow partnerId={partner.id} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Acceptance policy</CardTitle>
          <CardDescription>
            Synchronising is not publishing. Every listing they share is stored and kept current; this only decides what is displayed. Changing it
            applies to the listings already stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PolicyForm partnerId={partner.id} policy={partner.acceptancePolicy} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What they see of your listings</CardTitle>
          <CardDescription>
            Anything not granted is withheld on this node before a listing is sent — they are never sent a value and asked to ignore it. Which
            listings they receive is set on each listing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroupsForm partnerId={partner.id} granted={(received?.field_groups as string[] | undefined) ?? []} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How often they may ask</CardTitle>
          <CardDescription>
            Every signed request from this partner counts. Past the limit it is answered 429 and told how long to wait. Raise the figure for a partner
            with a large inventory to fetch for the first time, rather than have its first sync take days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RateLimitForm
            partnerId={partner.id}
            ratePerHour={(received?.rate_per_hour as number | null | undefined) ?? null}
            defaultPerHour={DEFAULT_RATE_PER_HOUR}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Identity and keys</CardTitle>
          <CardDescription>Read from their discovery document on {when(partner.keysFetchedAt)}.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Trust</dt>
            <dd>
              <Chip color={partner.trustLevel === "verified" ? "success" : partner.trustLevel === "blocked" ? "danger" : "warning"}>
                {partner.trustLevel}
              </Chip>
            </dd>
            <dt className="text-muted">Node UUID</dt>
            <dd className="font-mono">{partner.nodeUuid}</dd>
            <dt className="text-muted">Published keys</dt>
            <dd className="flex flex-col gap-1 font-mono">
              {partner.keys.map((key, index) => (
                <span key={key.keyId}>
                  {key.keyId}
                  {index === 0 && <span className="text-muted font-sans"> · current</span>}
                  {key.keyId === partner.pinnedKeyId && <span className="font-sans font-medium"> · pinned</span>}
                </span>
              ))}
            </dd>
            <dt className="text-muted">Pin</dt>
            <dd>
              {partner.pinnedKeyId === null ? (
                "Not pinned — a key they rotate to is accepted automatically."
              ) : partner.keys.some((key) => key.keyId === partner.pinnedKeyId) && partner.keys[0]?.keyId === partner.pinnedKeyId ? (
                <span className="font-mono">{partner.pinnedKeyId}</span>
              ) : (
                <span className="text-danger">
                  Pinned to <span className="font-mono">{partner.pinnedKeyId}</span>, which is no longer their current signing key. Requests signed
                  with the new key are rejected until you confirm it below.
                </span>
              )}
            </dd>
          </dl>
          <RefreshKeys partnerId={partner.id} pinned={partner.pinnedKeyId !== null} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Partnership request</CardTitle>
          <CardDescription>
            {partner.requestSentAt === null ? "Not delivered yet." : `Delivered ${when(partner.requestSentAt)}.`} It tells their administrator who is
            asking, and why, before they approve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Introduce
            partnerId={partner.id}
            nodeName={parseNodeIdentity(process.env).name}
            contactEmail={session.email ?? ""}
            sent={partner.requestSentAt !== null}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ending the partnership</CardTitle>
        </CardHeader>
        <CardContent>
          <TrustAndRemoval partnerId={partner.id} trustLevel={partner.trustLevel} removable={copies === 0} />
        </CardContent>
      </Card>
    </main>
  );
}
