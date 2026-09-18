import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { builderChoices, categoryChoices } from "@/lib/federation/registry";
import { userClient } from "@/lib/supabase/server";
import { createListingAction } from "../actions";
import { ListingForm } from "../listing-form";

export const dynamic = "force-dynamic";

export default async function NewListingPage({ searchParams }: PageProps<"/listings/new">) {
  await requireRole("broker");
  const listingType = (await searchParams).type === "charter" ? "charter" : "sale";
  const { data: vessels } = await (
    await userClient()
  )
    .from("vessels")
    .select("id, builder_name, model_name, year_built, listings(name)")
    .order("id", { ascending: false })
    .limit(100);

  return (
    <main className="flex flex-col gap-6">
      <header>
        <Link href="/listings" className="text-muted text-sm underline-offset-4 hover:underline">
          ← Listings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">New {listingType} listing</h1>
        <p className="text-muted mt-1 text-sm">
          Sale or charter is chosen now and cannot be changed later. The listing starts as a draft: nothing is sent to any partner until you make it
          active.
        </p>
      </header>
      <ListingForm
        action={createListingAction}
        values={{ listingType }}
        builders={builderChoices}
        categories={categoryChoices}
        vessels={(vessels ?? []).map((vessel) => ({
          id: vessel.id,
          label: [
            [vessel.builder_name, vessel.model_name, vessel.year_built].filter(Boolean).join(" "),
            (vessel.listings as { name: string }[]).map((l) => l.name).join(", "),
          ]
            .filter(Boolean)
            .join(" — "),
        }))}
        submitLabel="Create draft"
      />
    </main>
  );
}
