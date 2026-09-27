import { Alert, AlertContent, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@heroui/react";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/session";
import { userClient } from "@/lib/supabase/server";
import { DeleteGroupForm, GroupForm, type GroupPartner } from "./group-forms";

export const dynamic = "force-dynamic";

export default async function PartnerGroupsPage({ searchParams }: PageProps<"/partners/groups">) {
  await requirePermission("federation.manage");
  const { deleted } = await searchParams;
  const supabase = await userClient();
  const [{ data: groups }, { data: members }, { data: partners }] = await Promise.all([
    supabase.from("partner_groups").select("id, name").order("name"),
    supabase.from("partner_group_members").select("group_id, partner_id"),
    supabase.from("federation_partners").select("id, node_name, domain").neq("trust_level", "blocked").order("node_name"),
  ]);
  const choices = (partners ?? []) as GroupPartner[];

  return (
    <main className="flex flex-col gap-8">
      <header>
        <p className="text-sm">
          <Link href="/partners" className="underline-offset-4 hover:underline">
            Partners
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Partner groups</h1>
        <p className="text-muted mt-1 text-sm">
          Named sets of partners, to share a listing with several at once. A group is resolved when a partner polls, so changing its members changes
          what they receive without touching any listing.
        </p>
      </header>

      {deleted === "1" && (
        <Alert status="success">
          <AlertContent>
            <AlertDescription>Group deleted.</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      {(groups ?? []).map((group) => (
        <Card key={group.id}>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <GroupForm
              group={{
                id: group.id,
                name: group.name,
                memberIds: (members ?? []).filter((m) => m.group_id === group.id).map((m) => m.partner_id as number),
              }}
              partners={choices}
            />
            <DeleteGroupForm groupId={group.id} />
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>New group</CardTitle>
          <CardDescription>Blocked partners are not offered.</CardDescription>
        </CardHeader>
        <CardContent>
          <GroupForm group={null} partners={choices} />
        </CardContent>
      </Card>
    </main>
  );
}
