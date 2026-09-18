// Database lane: this node's own vessels and listings — the invariants the
// database enforces whatever code is writing, and the per-role access rules.
// Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const EDITOR = "00000000-0000-4000-8000-0000000000b1";
const BROKER = "00000000-0000-4000-8000-0000000000b2";
const OTHER_BROKER = "00000000-0000-4000-8000-0000000000b3";
const VIEWER = "00000000-0000-4000-8000-0000000000b4";
const NO_ROLE = "00000000-0000-4000-8000-0000000000b5";

const client = new pg.Client(config);
let vesselId: string;

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  await client.query(
    "insert into auth.users (id, email) values ($1, 'e@node.example'), ($2, 'b@node.example'), ($3, 'o@node.example'), ($4, 'v@node.example'), ($5, 'n@node.example')",
    [EDITOR, BROKER, OTHER_BROKER, VIEWER, NO_ROLE],
  );
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'editor'), ($2, 'broker'), ($3, 'broker'), ($4, 'viewer')", [
    EDITOR,
    BROKER,
    OTHER_BROKER,
    VIEWER,
  ]);
  vesselId = (
    await client.query(
      "insert into public.vessels (builder_name, builder_slug, year_built, loa_m) values ('Maritimo', 'maritimo', 2016, 15.24) returning id",
    )
  ).rows[0].id;
});
afterEach(() => client.query("rollback"));

/** The columns these tests read back from a listing row. */
interface StoredListing {
  id: string;
  uuid: string;
  status: string;
  name: string;
  listed_at: Date | null;
  federation_updated_at: Date;
  price_amount: string | null;
}

async function createListing(values: Record<string, unknown> = {}): Promise<StoredListing> {
  const row = { vessel_id: vesselId, listing_type: "sale", name: "TEST PATTERN", ...values };
  const columns = Object.keys(row);
  const { rows } = await client.query<StoredListing>(
    `insert into public.listings (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(row),
  );
  return rows[0]!;
}

const reload = async (id: string) => (await client.query<StoredListing>("select * from public.listings where id = $1", [id])).rows[0]!;

async function attempt(query: string, values: unknown[] = []): Promise<string | null> {
  await client.query("savepoint attempt");
  try {
    await client.query(query, values);
    return null;
  } catch (error) {
    await client.query("rollback to savepoint attempt");
    return (error as Error).message;
  }
}

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

describe("ID-1 listing identity", () => {
  it("mints a UUID at creation, different for every listing", async () => {
    const [first, second] = [await createListing(), await createListing()];
    expect(first.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.uuid).not.toBe(first.uuid);
  });

  it("the UUID can never be changed", async () => {
    const listing = await createListing();
    expect(await attempt("update public.listings set uuid = gen_random_uuid() where id = $1", [listing.id])).toMatch(/UUID never changes/);
  });

  it("the type is chosen at creation and can never be changed", async () => {
    const listing = await createListing();
    expect(await attempt("update public.listings set listing_type = 'charter' where id = $1", [listing.id])).toMatch(/type is chosen at creation/);
  });

  it("a vessel for sale and for charter is one vessel with two listings", async () => {
    await createListing({ listing_type: "sale" });
    await createListing({ listing_type: "charter", charter: "{}" });
    expect((await client.query("select count(*)::int n from public.listings where vessel_id = $1", [vesselId])).rows[0].n).toBe(2);
  });
});

describe("ID-8 lifecycle", () => {
  it("starts as a draft", async () => {
    expect((await createListing()).status).toBe("draft");
  });

  it.each([
    ["draft", "active"],
    ["active", "under_offer"],
    ["under_offer", "active"],
    ["active", "sold"],
    ["under_offer", "withdrawn"],
  ])("allows %s → %s", async (from, to) => {
    const listing = await createListing({ status: from });
    expect(await attempt("update public.listings set status = $2 where id = $1", [listing.id, to])).toBeNull();
  });

  it.each([
    ["draft", "sold"],
    ["draft", "under_offer"],
    ["active", "draft"],
    ["sold", "active"],
    ["withdrawn", "active"],
    ["sold", "withdrawn"],
  ])("refuses %s → %s", async (from, to) => {
    const listing = await createListing({ status: from });
    expect(await attempt("update public.listings set status = $2 where id = $1", [listing.id, to])).toMatch(/cannot go from/);
  });

  it("records when the listing first went active, and keeps that date", async () => {
    const listing = await createListing();
    expect(listing.listed_at).toBeNull();
    await client.query("update public.listings set status = 'active' where id = $1", [listing.id]);
    const listed = (await reload(listing.id)).listed_at;
    expect(listed).not.toBeNull();
    await client.query("update public.listings set status = 'under_offer' where id = $1", [listing.id]);
    await client.query("update public.listings set status = 'active' where id = $1", [listing.id]);
    expect((await reload(listing.id)).listed_at).toEqual(listed);
  });
});

describe("API-4 the wire timestamp reflects every change a partner can see", () => {
  it("moves when a listing field changes", async () => {
    const listing = await createListing({ status: "active" });
    await client.query("update public.listings set name = 'RENAMED' where id = $1", [listing.id]);
    expect((await reload(listing.id)).federation_updated_at.getTime()).toBeGreaterThan(listing.federation_updated_at.getTime());
  });

  it("moves when a stored block changes", async () => {
    const listing = await createListing({ status: "active" });
    await client.query(`update public.listings set features = '[{"name": "Seabob", "quantity": 2}]' where id = $1`, [listing.id]);
    expect((await reload(listing.id)).federation_updated_at.getTime()).toBeGreaterThan(listing.federation_updated_at.getTime());
  });

  it("moves when the vessel changes — the vessel block is on the wire", async () => {
    const listing = await createListing({ status: "active" });
    await client.query("update public.vessels set hin = 'OEOM5021G516' where id = $1", [vesselId]);
    expect((await reload(listing.id)).federation_updated_at.getTime()).toBeGreaterThan(listing.federation_updated_at.getTime());
  });

  it("does not move for a save that changes nothing, or for a reassignment — neither is visible to a partner", async () => {
    const listing = await createListing({ status: "active" });
    await client.query("update public.listings set name = name where id = $1", [listing.id]);
    await client.query("update public.listings set assigned_broker_id = $2 where id = $1", [listing.id, BROKER]);
    expect((await reload(listing.id)).federation_updated_at).toEqual(listing.federation_updated_at);
  });
});

describe("API-12 / LS-10 prices", () => {
  const history = async (id: string) =>
    (await client.query("select amount, currency from public.price_history where listing_id = $1 order by changed_at desc, id desc", [id])).rows;

  it("stores the amount as the decimal string that goes on the wire", async () => {
    const listing = await createListing({ price_amount: "1388000.50", price_currency: "USD" });
    expect(listing.price_amount).toBe("1388000.50");
  });

  it.each(["1,388,000", "1388000.", "$1388000", "1.388e6", "-5"])("refuses the amount %s", async (amount) => {
    expect(
      await attempt("insert into public.listings (vessel_id, listing_type, name, price_amount, price_currency) values ($1, 'sale', 'X', $2, 'USD')", [
        vesselId,
        amount,
      ]),
    ).toMatch(/check constraint/);
  });

  it("refuses an amount without a currency, and a price on a charter listing", async () => {
    expect(
      await attempt("insert into public.listings (vessel_id, listing_type, name, price_amount) values ($1, 'sale', 'X', '100')", [vesselId]),
    ).toMatch(/amount_and_currency/);
    expect(
      await attempt(
        "insert into public.listings (vessel_id, listing_type, name, price_amount, price_currency) values ($1, 'charter', 'X', '100', 'EUR')",
        [vesselId],
      ),
    ).toMatch(/charter_has_no_price/);
  });

  it("appends to the history on every change, newest first, the newest being the current price", async () => {
    const listing = await createListing({ status: "active", price_amount: "1450000", price_currency: "USD" });
    await client.query("update public.listings set price_amount = '1388000' where id = $1", [listing.id]);
    await client.query("update public.listings set name = 'RENAMED' where id = $1", [listing.id]);
    expect(await history(listing.id)).toEqual([
      { amount: "1388000", currency: "USD" },
      { amount: "1450000", currency: "USD" },
    ]);
  });

  it("keeps draft-era prices out of the history: it starts when the listing goes live", async () => {
    const listing = await createListing({ price_amount: "2000000", price_currency: "EUR" });
    await client.query("update public.listings set price_amount = '1900000' where id = $1", [listing.id]);
    expect(await history(listing.id)).toEqual([]);
    await client.query("update public.listings set status = 'active' where id = $1", [listing.id]);
    expect(await history(listing.id)).toEqual([{ amount: "1900000", currency: "EUR" }]);
  });

  it("is append-only", async () => {
    const listing = await createListing({ status: "active", price_amount: "1450000", price_currency: "USD" });
    expect(await attempt("update public.price_history set amount = '1' where listing_id = $1", [listing.id])).toMatch(/append-only/);
  });
});

describe("row level security: who may do what", () => {
  it("a broker sees and changes only the listings assigned to them", async () => {
    const mine = await createListing({ assigned_broker_id: BROKER, name: "MINE" });
    await createListing({ assigned_broker_id: OTHER_BROKER, name: "THEIRS" });
    await createListing({ name: "UNASSIGNED" });

    expect((await asUser(BROKER, "select name from public.listings")).map((row) => row.name)).toEqual(["MINE"]);
    expect(await asUser(BROKER, "update public.listings set name = 'EDITED' returning name")).toEqual([{ name: "EDITED" }]);
    expect((await reload(mine.id)).name).toBe("MINE"); // the savepoint undid the edit; only `mine` was reachable
  });

  it("a broker cannot hand their listing to someone else, or create one for someone else", async () => {
    const mine = await createListing({ assigned_broker_id: BROKER });
    await expect(asUser(BROKER, "update public.listings set assigned_broker_id = $1 where id = $2", [OTHER_BROKER, mine.id])).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      asUser(BROKER, "insert into public.listings (vessel_id, listing_type, name, assigned_broker_id) values ($1, 'sale', 'X', $2)", [
        vesselId,
        OTHER_BROKER,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("an editor sees and changes everything", async () => {
    await createListing({ assigned_broker_id: BROKER });
    await createListing();
    expect(await asUser(EDITOR, "select id from public.listings")).toHaveLength(2);
    expect(await asUser(EDITOR, "update public.listings set summary = 'x' returning id")).toHaveLength(2);
  });

  it("a viewer reads everything and changes nothing", async () => {
    await createListing();
    expect(await asUser(VIEWER, "select id from public.listings")).toHaveLength(1);
    expect(await asUser(VIEWER, "update public.listings set summary = 'x' returning id")).toEqual([]);
    await expect(asUser(VIEWER, "insert into public.listings (vessel_id, listing_type, name) values ($1, 'sale', 'X')", [vesselId])).rejects.toThrow(
      /row-level security/,
    );
  });

  it("a signed-in user with no role sees nothing", async () => {
    await createListing();
    expect(await asUser(NO_ROLE, "select id from public.listings")).toEqual([]);
    expect(await asUser(NO_ROLE, "select id from public.vessels")).toEqual([]);
  });

  it("only a draft can be deleted: a distributed listing ends by being withdrawn, which partners are told about", async () => {
    const draft = await createListing();
    const live = await createListing({ status: "active" });
    expect(await asUser(EDITOR, "delete from public.listings where id = $1 returning id", [live.id])).toEqual([]);
    expect(await asUser(EDITOR, "delete from public.listings where id = $1 returning id", [draft.id])).toHaveLength(1);
  });

  it("nobody signed in can write the price history", async () => {
    const listing = await createListing({ status: "active", price_amount: "100", price_currency: "EUR" });
    await expect(
      asUser(EDITOR, "insert into public.price_history (listing_id, amount, currency) values ($1, '1', 'EUR')", [listing.id]),
    ).rejects.toThrow(/permission denied/);
    expect(await asUser(EDITOR, "select amount from public.price_history")).toEqual([{ amount: "100" }]);
  });

  it.each(["vessels", "listings", "price_history"])("the publishable key alone cannot read public.%s", async (table) => {
    await client.query("savepoint as_anon");
    await client.query("set local role anon");
    await expect(client.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint as_anon");
  });
});
