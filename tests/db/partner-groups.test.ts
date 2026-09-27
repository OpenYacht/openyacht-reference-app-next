// Database lane: partner groups, curated partners and the additive visibility
// rule shared with the other OpenYacht implementations. Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-000000000e01";
const EDITOR = "00000000-0000-4000-8000-000000000e02";

const client = new pg.Client(config);
let vesselId: string;
let standard: string;
let curated: string;

beforeAll(() => client.connect());
afterAll(() => client.end());

const partner = async (domain: string, scope: string) =>
  (
    await client.query(
      "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level, sharing_scope) values ($1, gen_random_uuid(), $1, '[]', 'verified', $2) returning id",
      [domain, scope],
    )
  ).rows[0].id as string;

beforeEach(async () => {
  await client.query("begin");
  // Only this test's inventory and partners exist inside the transaction.
  await client.query("delete from public.listings");
  await client.query("delete from public.vessels");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_alerts");
  await client.query("delete from public.federation_partners");
  await client.query("delete from public.partner_groups");
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.role_permissions");
  await client.query("set local session_replication_role = origin");
  await client.query("insert into public.role_permissions (role, permission) values ('editor', 'listings.manage')");
  await client.query("insert into auth.users (id, email) values ($1, 's@node.example'), ($2, 'e@node.example')", [SUPER_ADMIN, EDITOR]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin'), ($2, 'editor')", [SUPER_ADMIN, EDITOR]);
  vesselId = (await client.query("insert into public.vessels (builder_name) values ('Maritimo') returning id")).rows[0].id;
  standard = await partner("standard.example", "standard");
  curated = await partner("curated.example", "curated");
});
afterEach(() => client.query("rollback"));

async function asUser(userId: string, query: string, values: unknown[] = []) {
  await client.query("savepoint as_user");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
      userId,
    ]);
    const { rows } = await client.query(query, values);
    await client.query("reset role");
    await client.query("release savepoint as_user");
    return rows;
  } catch (error) {
    await client.query("rollback to savepoint as_user");
    throw error;
  }
}

const listing = async (type = "sale") =>
  (
    await client.query("insert into public.listings (vessel_id, listing_type, name, status) values ($1, $2, 'TEST PATTERN', 'active') returning id", [
      vesselId,
      type,
    ])
  ).rows[0].id as string;
const share = (listingId: string, audience: string, partners: string[] = [], groups: string[] = []) =>
  client.query("select public.set_listing_sharing($1, $2, $3, $4)", [listingId, audience, partners, groups]);
const group = (name: string, members: string[]) =>
  client.query("select public.save_partner_group(null, $1, $2) as id", [name, members]).then((r) => r.rows[0].id as string);
const visible = (listingId: string, partnerId: string) =>
  client
    .query("select private.listing_visible_to(l, p) as v from public.listings l, public.federation_partners p where l.id = $1 and p.id = $2", [
      listingId,
      partnerId,
    ])
    .then((r) => r.rows[0].v as boolean);
const events = (partnerId: string) =>
  client
    .query("select listing_id, visible from public.visibility_events where partner_id = $1 order by id", [partnerId])
    .then((r) => r.rows.map((row) => [row.listing_id, row.visible]));

describe("the visibility rule", () => {
  // Every combination of audience × scope × how the partner is reached.
  const TABLE: [audience: string, reach: "none" | "direct" | "group", standardSees: boolean, curatedSees: boolean][] = [
    ["everyone", "none", true, false],
    ["everyone", "direct", true, true],
    ["everyone", "group", true, true],
    ["selected", "none", false, false],
    ["selected", "direct", true, true],
    ["selected", "group", true, true],
    ["none", "none", false, false],
    ["none", "direct", false, false],
    ["none", "group", false, false],
  ];

  it.each(TABLE)("audience %s, shared %s: standard %s, curated %s", async (audience, reach, standardSees, curatedSees) => {
    const id = await listing();
    const both = [standard, curated];
    if (reach === "group") await share(id, audience, [], [await group("Both", both)]);
    else await share(id, audience, reach === "direct" ? both : []);
    expect(await visible(id, standard)).toBe(standardSees);
    expect(await visible(id, curated)).toBe(curatedSees);
  });

  it("keeps a curated lineup through hiding and showing again", async () => {
    const id = await listing();
    await share(id, "everyone", [curated]);
    await share(id, "none", [curated]);
    expect(await visible(id, curated)).toBe(false);
    await share(id, "everyone", [curated]);
    expect(await visible(id, curated)).toBe(true);
  });
});

describe("changes replay through the visibility events", () => {
  it("a scope flip hides and resurfaces what the partner saw only through everyone", async () => {
    const everyoneOnly = await listing();
    const picked = await listing();
    await share(everyoneOnly, "everyone");
    await share(picked, "everyone", [standard]);
    await client.query("delete from public.visibility_events");

    await client.query("select public.set_partner_sharing_scope($1, 'curated')", [standard]);
    expect(await events(standard)).toEqual([[everyoneOnly, false]]);
    await client.query("select public.set_partner_sharing_scope($1, 'standard')", [standard]);
    expect(await events(standard)).toEqual([
      [everyoneOnly, false],
      [everyoneOnly, true],
    ]);
  });

  it("group membership changes reach the members, and deleting the group takes its shares away", async () => {
    const id = await listing();
    const groupId = await group("Shows", []);
    await share(id, "selected", [], [groupId]);
    expect(await visible(id, curated)).toBe(false);

    await client.query("select public.save_partner_group($1, 'Shows', $2)", [groupId, [curated]]);
    expect(await events(curated)).toEqual([[id, true]]);
    await client.query("select public.delete_partner_group($1)", [groupId]);
    expect(await events(curated)).toEqual([
      [id, true],
      [id, false],
    ]);
  });

  it("the partner-side picker saves one type at a time, never unsharing the other", async () => {
    const sale = await listing("sale");
    const charter = await listing("charter");
    await client.query("select public.set_partner_direct_shares($1, 'charter', $2)", [curated, [charter]]);
    await client.query("select public.set_partner_direct_shares($1, 'sale', $2)", [curated, [sale]]);
    await client.query("select public.set_partner_direct_shares($1, 'sale', $2)", [curated, []]);
    expect(await visible(sale, curated)).toBe(false);
    expect(await visible(charter, curated)).toBe(true);
  });

  it("drafts move nothing", async () => {
    const draft = (
      await client.query("insert into public.listings (vessel_id, listing_type, name) values ($1, 'sale', 'DRAFT') returning id", [vesselId])
    ).rows[0].id;
    await share(draft, "everyone", [curated]);
    await client.query("select public.set_partner_sharing_scope($1, 'curated')", [standard]);
    expect(await events(standard)).toEqual([]);
    expect(await events(curated)).toEqual([]);
  });
});

describe("who may", () => {
  it("change scope, direct shares and groups: federation.manage only", async () => {
    await expect(asUser(EDITOR, "select public.set_partner_sharing_scope($1, 'curated')", [standard])).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(EDITOR, "select public.set_partner_direct_shares($1, 'sale', '{}')", [standard])).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(EDITOR, "select public.save_partner_group(null, 'X', '{}')")).rejects.toMatchObject({ code: "42501" });
    await asUser(SUPER_ADMIN, "select public.save_partner_group(null, 'X', $1)", [[standard]]);
  });

  it("see groups to share with, but not who is in them, with listings.manage", async () => {
    await group("Shows", [curated]);
    expect(await asUser(EDITOR, "select name from public.shareable_groups()")).toEqual([{ name: "Shows" }]);
    expect(await asUser(EDITOR, "select * from public.partner_group_members")).toEqual([]);
  });
});
