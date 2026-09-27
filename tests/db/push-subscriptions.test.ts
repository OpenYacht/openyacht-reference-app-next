// Database lane: the push delivery queue (API-10) — fan-out from the feed's
// own sources, the send-time decision, leases, backoff and the 24-hour
// ceiling. Every test rolls back, so nothing is ever sent.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const client = new pg.Client(config);
let vesselId: string;
let pushed: string; // verified, with a callback
let polling: string; // verified, no callback

beforeAll(() => client.connect());
afterAll(() => client.end());

const partner = async (domain: string, callback: string | null) =>
  (
    await client.query(
      "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level, push_callback_url) values ($1, gen_random_uuid(), $1, '[]', 'verified', $2) returning id",
      [domain, callback],
    )
  ).rows[0].id as string;

beforeEach(async () => {
  await client.query("begin");
  await client.query("delete from public.listings");
  await client.query("delete from public.vessels");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_alerts");
  await client.query("delete from public.federation_partners");
  await client.query("update public.node_settings set push_enabled = true where id");
  vesselId = (await client.query("insert into public.vessels (builder_name) values ('Maritimo') returning id")).rows[0].id;
  pushed = await partner("pushed.example", "https://pushed.example/openyacht/v1/inbox");
  polling = await partner("polling.example", null);
});
afterEach(() => client.query("rollback"));

const listing = async (status = "active") =>
  (
    await client.query("insert into public.listings (vessel_id, listing_type, name, status) values ($1, 'sale', 'TEST PATTERN', $2) returning id", [
      vesselId,
      status,
    ])
  ).rows[0].id as string;
const queue = () =>
  client
    .query("select partner_id, listing_id, changed_at, next_attempt_at, attempts from public.push_deliveries order by listing_id")
    .then((r) => r.rows);
const share = (id: string, audience = "everyone") => client.query("select public.set_listing_sharing($1, $2, '{}')", [id, audience]);

describe("API-10 fan-out", () => {
  it("queues a delivery for each subscribed partner that can see the change, and none for others", async () => {
    const id = await listing();
    await share(id, "selected");
    await client.query("delete from public.push_deliveries");
    await share(id, "everyone");
    expect(await queue()).toEqual([expect.objectContaining({ partner_id: pushed, listing_id: id })]);
  });

  it("folds a burst of edits into the waiting delivery without moving its retry slot", async () => {
    const id = await listing();
    await share(id);
    const [before] = await queue();
    await client.query("update public.listings set name = 'RENAMED' where id = $1", [id]);
    await client.query("update public.listings set summary = 'Changed twice' where id = $1", [id]);
    const after = await queue();
    expect(after).toHaveLength(1);
    expect(after[0].changed_at.getTime()).toBeGreaterThan(before.changed_at.getTime());
    expect(after[0].next_attempt_at).toEqual(before.next_attempt_at);
  });

  it("queues nothing for a draft, or while pushes are switched off", async () => {
    await share(await listing("draft"));
    expect(await queue()).toEqual([]);
    await client.query("update public.node_settings set push_enabled = false where id");
    await share(await listing());
    expect(await queue()).toEqual([]);
  });

  it("owes a partner the tombstone of a listing it has seen", async () => {
    const id = await listing();
    await share(id);
    await client.query("delete from public.push_deliveries");
    await share(id, "none");
    expect(await queue()).toEqual([expect.objectContaining({ partner_id: pushed, listing_id: id })]);
    const { rows } = await client.query("select kind, tombstone_status from public.feed_row_for($1, $2)", [pushed, id]);
    expect(rows).toEqual([{ kind: "tombstone", tombstone_status: "withdrawn" }]);
  });
});

describe("the send-time decision", () => {
  it("is the polled feed's own row for that pair", async () => {
    const id = await listing();
    await share(id);
    const single = await client.query("select * from public.feed_row_for($1, $2)", [pushed, id]);
    const feed = await client.query("select * from public.feed_for_partner($1, null, null, null, 100) where listing_id = $2", [pushed, id]);
    expect(single.rows).toEqual(feed.rows);
    expect(single.rows[0].kind).toBe("listing");
  });
});

describe("the worker's side", () => {
  // changed_at as text, the way the worker receives it from the API: a Date
  // keeps milliseconds, and the queue compares microseconds.
  const claim = () =>
    client
      .query("select partner_id, listing_id, changed_at::text as changed_at, callback, domain from public.claim_push_deliveries(10)")
      .then((r) => r.rows);
  const finish = (row: { partner_id: string; listing_id: string; changed_at: string }, delivered: boolean) =>
    client
      .query("select public.finish_push_delivery($1, $2, $3, $4, $5) as outcome", [
        row.partner_id,
        row.listing_id,
        row.changed_at,
        delivered,
        delivered ? null : "503",
      ])
      .then((r) => r.rows[0].outcome as string);

  it("leases what it claims, and completes a delivery only if nothing changed meanwhile", async () => {
    const id = await listing();
    await share(id);
    const [claimed] = await claim();
    expect(claimed).toMatchObject({ callback: "https://pushed.example/openyacht/v1/inbox", domain: "pushed.example" });
    expect(await claim()).toEqual([]);

    await client.query("update public.listings set name = 'EDITED IN FLIGHT' where id = $1", [id]);
    expect(await finish(claimed, true)).toBe("changed");
    const [again] = await claim();
    expect(await finish(again, true)).toBe("delivered");
    expect(await queue()).toEqual([]);
  });

  it("backs off after a failure, and abandons a delivery 24 hours after it was queued", async () => {
    const id = await listing();
    await share(id);
    const [first] = await claim();
    expect(await finish(first, false)).toBe("retrying");
    const [row] = await queue();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(50_000);

    await client.query("update public.push_deliveries set queued_at = now() - interval '25 hours', next_attempt_at = now() - interval '1 second'");
    const [late] = await claim();
    expect(await finish(late, false)).toBe("abandoned");
    expect(await queue()).toEqual([]);
  });

  it("drops deliveries to a partner that is blocked or has withdrawn its callback", async () => {
    const id = await listing();
    await share(id);
    await client.query("update public.federation_partners set trust_level = 'blocked' where id = $1", [pushed]);
    expect(await claim()).toEqual([]);
    expect(await queue()).toEqual([]);
    expect(polling).toBeDefined();
  });
});

describe("switching pushes on and off", () => {
  it("needs the sync schedule, whose secret the delivery job uses", async () => {
    await client.query("select public.unschedule_sync()");
    await expect(client.query("select public.set_push_enabled(true)")).rejects.toMatchObject({ code: "P0001" });
  });

  it("drops what was waiting when switched off", async () => {
    await share(await listing());
    await client.query("select public.set_push_enabled(false)");
    expect(await queue()).toEqual([]);
    expect((await client.query("select push_enabled from public.node_settings")).rows[0].push_enabled).toBe(false);
  });
});

describe("API-11 recording a subscription", () => {
  const ADMIN = "00000000-0000-4000-8000-000000000f21";

  it("is written as the signed-in federation manager: the column is granted and RLS decides", async () => {
    await client.query("set local session_replication_role = replica");
    await client.query("delete from public.user_roles");
    await client.query("set local session_replication_role = origin");
    await client.query("insert into auth.users (id, email) values ($1, 'push-admin@node.example')", [ADMIN]);
    await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin')", [ADMIN]);
    await client.query("savepoint as_user");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
      JSON.stringify({ sub: ADMIN, role: "authenticated" }),
      ADMIN,
    ]);
    const { rowCount } = await client.query("update public.federation_partners set push_subscribed_at = now() where id = $1", [polling]);
    await client.query("reset role");
    await client.query("release savepoint as_user");
    expect(rowCount).toBe(1);
  });
});
