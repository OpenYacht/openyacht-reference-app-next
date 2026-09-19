// Database lane: sharing, visibility events and the partner feed. The feed is
// one careful SQL statement; this is where it is held to account. Every test
// rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const EDITOR = "00000000-0000-4000-8000-0000000000c1";
const BROKER = "00000000-0000-4000-8000-0000000000c2";
const VIEWER = "00000000-0000-4000-8000-0000000000c3";
const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000c4";

const client = new pg.Client(config);
let vesselId: string;
let alpha: string; // a verified partner
let beta: string; // another verified partner
let pending: string; // a provisional partner

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  // Only this test's inventory exists inside the transaction, whatever the
  // database holds. Deleting a listing takes its price history, shares and
  // visibility events with it.
  await client.query("delete from public.listings");
  await client.query("delete from public.vessels");
  // Only this test's partners exist inside the transaction, whatever the
  // database holds: sharing changes touch every verified partner.
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_partners");
  await client.query(
    "insert into auth.users (id, email) values ($1, 'e@node.example'), ($2, 'b@node.example'), ($3, 'v@node.example'), ($4, 's@node.example')",
    [EDITOR, BROKER, VIEWER, SUPER_ADMIN],
  );
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'editor'), ($2, 'broker'), ($3, 'viewer'), ($4, 'super_admin')", [
    EDITOR,
    BROKER,
    VIEWER,
    SUPER_ADMIN,
  ]);
  vesselId = (await client.query("insert into public.vessels (builder_name) values ('Maritimo') returning id")).rows[0].id;
  const partner = async (domain: string, trust: string) =>
    (
      await client.query(
        "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level) values ($1, gen_random_uuid(), $1, '[]', $2) returning id",
        [domain, trust],
      )
    ).rows[0].id as string;
  alpha = await partner("alpha.example", "verified");
  beta = await partner("beta.example", "verified");
  pending = await partner("pending.example", "provisional");
});
afterEach(() => client.query("rollback"));

interface Listing {
  id: string;
  uuid: string;
  federation_updated_at: Date;
}

async function createListing(values: Record<string, unknown> = {}): Promise<Listing> {
  const row = { vessel_id: vesselId, listing_type: "sale", name: "TEST PATTERN", status: "active", ...values };
  const columns = Object.keys(row);
  const { rows } = await client.query<Listing>(
    `insert into public.listings (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id, uuid, federation_updated_at`,
    Object.values(row),
  );
  return rows[0]!;
}

const share = (listingId: string, audience: string, partners: string[] = []) =>
  client
    .query<{ changed: number }>("select public.set_listing_sharing($1, $2, $3) as changed", [listingId, audience, partners])
    .then((r) => r.rows[0]!.changed);

interface FeedRow {
  listing_id: string;
  listing_uuid: string;
  effective_at: string;
  kind: "listing" | "tombstone";
  tombstone_status: string | null;
  tombstone_at: Date | null;
}

const feed = (partnerId: string, options: { since?: string | null; after?: FeedRow; limit?: number } = {}) =>
  client
    .query<FeedRow>("select * from public.feed_for_partner($1, $2, $3, $4, $5)", [
      partnerId,
      options.since ?? null,
      options.after?.effective_at ?? null,
      options.after?.listing_id ?? null,
      options.limit ?? 100,
    ])
    .then((r) => r.rows);

const events = (listingId: string) =>
  client.query("select partner_id, visible from public.visibility_events where listing_id = $1 order by id", [listingId]).then((r) => r.rows);

async function asUser<T extends pg.QueryResultRow>(userId: string, query: string, values: unknown[] = []): Promise<T[]> {
  await client.query("savepoint as_user");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
      userId,
    ]);
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.query("rollback to savepoint as_user");
  }
}

describe("API-5 what a partner sees", () => {
  it("everyone: every verified partner; a draft: nobody (LS-7); a provisional partner: nothing (FP-13)", async () => {
    const live = await createListing();
    await createListing({ status: "draft", name: "DRAFT" });
    expect((await feed(alpha)).map((row) => row.listing_id)).toEqual([live.id]);
    expect((await feed(beta)).map((row) => row.listing_id)).toEqual([live.id]);
    expect(await feed(pending)).toEqual([]);
  });

  it("selected: only the partners it is shared with", async () => {
    const listing = await createListing();
    await share(listing.id, "selected", [alpha]);
    expect(await feed(alpha)).toHaveLength(1);
    // Beta could see it and now cannot: a tombstone, not silence.
    expect((await feed(beta)).map((row) => row.kind)).toEqual(["tombstone"]);
  });

  it("a listing a partner has never been able to see does not appear at all — not even as a tombstone", async () => {
    const listing = await createListing({ status: "draft" });
    await share(listing.id, "selected", [alpha]);
    await client.query("update public.listings set status = 'active' where id = $1", [listing.id]);
    expect(await feed(alpha)).toHaveLength(1);
    expect(await feed(beta)).toEqual([]);
  });
});

describe("API-3 a polling partner never misses a removal", () => {
  it("a sold or withdrawn listing is a tombstone with its real status", async () => {
    const listing = await createListing();
    await client.query("update public.listings set status = 'sold' where id = $1", [listing.id]);
    expect(await feed(alpha)).toMatchObject([{ listing_uuid: listing.uuid, kind: "tombstone", tombstone_status: "sold" }]);
  });

  it("an unshared listing is a tombstone stamped at the moment of unsharing, and reads as `withdrawn`", async () => {
    const listing = await createListing();
    const before = (await feed(alpha))[0]!;
    await share(listing.id, "none");
    const [row] = await feed(alpha);
    expect(row).toMatchObject({ kind: "tombstone", tombstone_status: "withdrawn" });
    expect(row!.tombstone_at!.getTime()).toBeGreaterThan(listing.federation_updated_at.getTime());
    expect(row!.effective_at > before.effective_at).toBe(true);
  });

  it("unsharing is not an edit: the listing's own timestamp does not move, and other partners are told nothing", async () => {
    const listing = await createListing();
    const watermark = (await feed(beta))[0]!.effective_at;
    await share(listing.id, "selected", [beta]);
    const after = (await client.query("select federation_updated_at from public.listings where id = $1", [listing.id])).rows[0];
    expect(after.federation_updated_at).toEqual(listing.federation_updated_at);
    // Beta still sees it, unchanged: nothing new since its watermark but the boundary item itself.
    expect((await feed(beta, { since: watermark })).map((row) => [row.kind, row.effective_at])).toEqual([["listing", watermark]]);
  });

  it("the full cycle against a standing watermark: unshare → tombstone → re-share → listing → update → listing", async () => {
    const listing = await createListing();
    const watermark = (await feed(alpha))[0]!.effective_at;

    await share(listing.id, "none");
    let delta = await feed(alpha, { since: watermark });
    expect(delta).toMatchObject([{ kind: "tombstone", tombstone_status: "withdrawn" }]);

    // Re-shared: it returns in the delta although the listing itself never
    // changed — its own timestamp is still older than the partner's watermark.
    await share(listing.id, "everyone");
    delta = await feed(alpha, { since: delta[0]!.effective_at });
    expect(delta).toMatchObject([{ kind: "listing", listing_uuid: listing.uuid }]);
    const unchanged = (await client.query("select federation_updated_at from public.listings where id = $1", [listing.id])).rows[0];
    expect(unchanged.federation_updated_at).toEqual(listing.federation_updated_at);

    await client.query("update public.listings set name = 'RENAMED' where id = $1", [listing.id]);
    const next = await feed(alpha, { since: delta[0]!.effective_at });
    expect(next).toMatchObject([{ kind: "listing" }]);
    expect(next[0]!.effective_at > delta[0]!.effective_at).toBe(true);
  });

  it("drops an ended listing from the feed after twelve months", async () => {
    const listing = await createListing();
    await client.query("update public.listings set status = 'withdrawn' where id = $1", [listing.id]);
    expect(await feed(alpha)).toHaveLength(1);
    await client.query("set local session_replication_role = replica");
    await client.query("update public.listings set federation_updated_at = now() - interval '13 months' where id = $1", [listing.id]);
    await client.query("set local session_replication_role = origin");
    expect(await feed(alpha)).toEqual([]);
  });
});

describe("visibility events: state first, then the event", () => {
  it("records one event per partner whose view changed, and none for a change that changes nothing", async () => {
    const listing = await createListing();
    expect(await share(listing.id, "selected", [alpha])).toBe(1); // only beta lost it
    expect(await events(listing.id)).toEqual([{ partner_id: beta, visible: false }]);
    expect(await share(listing.id, "selected", [alpha])).toBe(0);
    expect(await share(listing.id, "everyone", [alpha])).toBe(1);
    expect(await events(listing.id)).toEqual([
      { partner_id: beta, visible: false },
      { partner_id: beta, visible: true },
    ]);
  });

  it("hiding a listing keeps its direct shares, so the selection survives", async () => {
    const listing = await createListing();
    await share(listing.id, "selected", [alpha]);
    await share(listing.id, "none", [alpha]);
    expect(await feed(alpha)).toMatchObject([{ kind: "tombstone" }]);
    await share(listing.id, "selected", [alpha]);
    expect(await feed(alpha)).toMatchObject([{ kind: "listing" }]);
  });

  it("never records events for a draft, or for a partner that is not verified", async () => {
    const draft = await createListing({ status: "draft" });
    await share(draft.id, "none");
    await share(draft.id, "everyone");
    expect(await events(draft.id)).toEqual([]);
    const live = await createListing();
    await share(live.id, "none");
    expect((await events(live.id)).map((event) => event.partner_id).sort()).toEqual([alpha, beta].sort());
  });

  it("is append-only", async () => {
    const listing = await createListing();
    await share(listing.id, "none");
    await client.query("savepoint attempt");
    await expect(client.query("update public.visibility_events set visible = true")).rejects.toThrow(/append-only/);
    await client.query("rollback to savepoint attempt");
  });
});

describe("API-2 keyset pagination", () => {
  it("walks every row exactly once, in order, however the pages fall", async () => {
    const created: string[] = [];
    for (let i = 0; i < 7; i++) created.push((await createListing({ name: `LISTING ${i}` })).id);

    const seen: string[] = [];
    let after: FeedRow | undefined;
    for (;;) {
      const pageRows = await feed(alpha, { after, limit: 3 });
      if (pageRows.length === 0) break;
      seen.push(...pageRows.map((row) => row.listing_id));
      after = pageRows.at(-1);
    }
    expect(seen).toEqual(created);
  });

  it("a row written while a partner is mid-crawl is neither skipped nor repeated", async () => {
    const first = await createListing({ name: "A" });
    const second = await createListing({ name: "B" });
    const pageOne = await feed(alpha, { limit: 1 });
    expect(pageOne.map((row) => row.listing_id)).toEqual([first.id]);
    // The first listing is edited after it was served: it moves to the end.
    await client.query("update public.listings set name = 'A2' where id = $1", [first.id]);
    const rest = await feed(alpha, { after: pageOne[0], limit: 10 });
    expect(rest.map((row) => row.listing_id)).toEqual([second.id, first.id]);
  });

  it("updated_since is inclusive", async () => {
    const listing = await createListing();
    const [row] = await feed(alpha);
    expect(await feed(alpha, { since: row!.effective_at })).toHaveLength(1);
    expect(await feed(alpha, { since: new Date(listing.federation_updated_at.getTime() + 1000).toISOString() })).toEqual([]);
  });
});

describe("dereferencing a canonical URI leaks nothing", () => {
  const resolve = (partnerId: string, uuid: string) =>
    client.query("select public.listing_for_partner($1, $2) as id", [partnerId, uuid]).then((r) => r.rows[0].id as string | null);

  it("visible → the listing; unshared, draft, unknown, or not yet approved → the same nothing", async () => {
    const visible = await createListing();
    const unshared = await createListing();
    await share(unshared.id, "selected", [beta]);
    const draft = await createListing({ status: "draft" });

    expect(await resolve(alpha, visible.uuid)).toBe(visible.id);
    for (const uuid of [unshared.uuid, draft.uuid, "018f6d2e-9f0a-7cc3-a1b2-3c4d5e6f7a8b"]) expect(await resolve(alpha, uuid)).toBeNull();
    expect(await resolve(pending, visible.uuid)).toBeNull();
  });

  it("a sold listing is still dereferenceable by a partner that could see it", async () => {
    const listing = await createListing();
    await client.query("update public.listings set status = 'sold' where id = $1", [listing.id]);
    expect(await resolve(alpha, listing.uuid)).toBe(listing.id);
  });
});

describe("who may change sharing", () => {
  it("an editor may; a viewer may not; a broker only for a listing assigned to them", async () => {
    const mine = await createListing({ assigned_broker_id: BROKER });
    const theirs = await createListing();
    const call = "select public.set_listing_sharing($1, 'none', '{}')";
    await expect(asUser(EDITOR, call, [theirs.id])).resolves.toBeDefined();
    await expect(asUser(BROKER, call, [mine.id])).resolves.toBeDefined();
    // `theirs` is unassigned: comparing NULL with the caller's id must refuse, not shrug.
    await expect(asUser(BROKER, call, [theirs.id])).rejects.toThrow(/Not allowed/);
    await expect(asUser(VIEWER, call, [theirs.id])).rejects.toThrow(/Not allowed/);
  });

  it("audience cannot be written directly, so no sharing change can skip its events", async () => {
    const listing = await createListing();
    await expect(asUser(EDITOR, "update public.listings set audience = 'none' where id = $1", [listing.id])).rejects.toThrow(/permission denied/);
    // …while ordinary fields still can.
    expect(await asUser(EDITOR, "update public.listings set name = 'RENAMED' where id = $1 returning name", [listing.id])).toEqual([
      { name: "RENAMED" },
    ]);
  });

  it("the feed and the dereference are the service role's alone", async () => {
    await expect(asUser(EDITOR, "select * from public.feed_for_partner($1, null, null, null, 10)", [alpha])).rejects.toThrow(/permission denied/);
    await expect(asUser(EDITOR, "select public.listing_for_partner($1, gen_random_uuid())", [alpha])).rejects.toThrow(/permission denied/);
  });
});

describe("LS-14 changing what a partner is granted", () => {
  const grant = (partnerId: string, groups: string[]) =>
    client.query<{ n: number }>("select public.set_partner_field_groups($1, $2) as n", [partnerId, groups]).then((r) => r.rows[0]!.n);

  it("re-announces every listing the partner can see — to that partner alone — though no listing changed", async () => {
    const listing = await createListing();
    await createListing({ status: "draft", name: "DRAFT" });
    const alphaMark = (await feed(alpha))[0]!.effective_at;
    const betaMark = (await feed(beta))[0]!.effective_at;

    expect(await grant(alpha, ["pricing", "history"])).toBe(1); // the live listing, not the draft

    const again = await feed(alpha, { since: alphaMark });
    expect(again).toMatchObject([{ kind: "listing", listing_uuid: listing.uuid }]);
    expect(again[0]!.effective_at > alphaMark).toBe(true);
    // Beta's view is untouched, and the listing's own timestamp never moved.
    expect((await feed(beta, { since: betaMark })).map((row) => row.effective_at)).toEqual([betaMark]);
    const unchanged = (await client.query("select federation_updated_at from public.listings where id = $1", [listing.id])).rows[0];
    expect(unchanged.federation_updated_at).toEqual(listing.federation_updated_at);
  });

  it("announces nothing when the set is unchanged, whatever its order", async () => {
    await createListing();
    await grant(alpha, ["pricing", "history"]);
    expect(await grant(alpha, ["history", "pricing"])).toBe(0);
  });

  it("refuses a field group the protocol does not define", async () => {
    await client.query("savepoint attempt");
    await expect(grant(alpha, ["pricing", "everything"])).rejects.toThrow(/check constraint/);
    await client.query("rollback to savepoint attempt");
  });

  it("is a super admin's alone, and field_groups cannot be written around it", async () => {
    const call = "select public.set_partner_field_groups($1, '{pricing}')";
    await expect(asUser(EDITOR, call, [alpha])).rejects.toThrow(/Only a super admin/);
    await expect(asUser(SUPER_ADMIN, call, [alpha])).resolves.toBeDefined();
    await expect(asUser(SUPER_ADMIN, "update public.federation_partners set field_groups = '{}' where id = $1", [alpha])).rejects.toThrow(
      /permission denied/,
    );
    // …while the columns an administrator does set directly still can be.
    expect(
      await asUser(SUPER_ADMIN, "update public.federation_partners set acceptance_policy = 'accept_all' where id = $1 returning id", [alpha]),
    ).toHaveLength(1);
  });
});

describe("choosing partners to share with", () => {
  const names = (userId: string) =>
    asUser<{ domain: string }>(userId, "select domain from public.shareable_partners()").then((rows) => rows.map((row) => row.domain));

  it("editors and brokers see the verified partners' names — and nothing else about them", async () => {
    expect(await names(EDITOR)).toEqual(["alpha.example", "beta.example"]);
    expect(await names(BROKER)).toEqual(["alpha.example", "beta.example"]);
    expect(await asUser(EDITOR, "select * from public.federation_partners")).toEqual([]);
  });

  it("a viewer sees none", async () => {
    expect(await names(VIEWER)).toEqual([]);
  });
});

describe("the time a page reports as generated_at is safe to poll from", () => {
  const watermark = () => client.query<{ at: Date }>("select public.feed_watermark() as at").then((r) => r.rows[0]!.at);

  it("comes from the database's clock, a few seconds in the past", async () => {
    const { rows } = await client.query<{ behind: number }>(
      "select extract(epoch from clock_timestamp() - public.feed_watermark())::float as behind",
    );
    expect(rows[0]!.behind).toBeGreaterThan(4);
    expect(rows[0]!.behind).toBeLessThan(10);
  });

  it("a change made after a poll is in the next poll, whatever the application server's clock says", async () => {
    const listing = await createListing();
    const polledFrom = await watermark();
    // Shared away and back, and edited: each stamped by the database, moments after that poll.
    await share(listing.id, "selected", [beta]);
    await share(listing.id, "selected", [alpha, beta]);
    await client.query("update public.listings set summary = 'Reduced.' where id = $1", [listing.id]);
    expect((await feed(alpha, { since: polledFrom.toISOString() })).map((row) => row.kind)).toEqual(["listing"]);
  });

  it.each(["anon", "authenticated"])("is not callable by %s", async (role) => {
    await client.query("savepoint as_role");
    await client.query(`set local role ${role}`);
    await expect(client.query("select public.feed_watermark()")).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint as_role");
  });
});
