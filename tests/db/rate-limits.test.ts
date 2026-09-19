// Database lane: the per-partner token bucket. Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const client = new pg.Client(config);
let partnerId: string;

beforeAll(() => client.connect());
afterAll(() => client.end());
beforeEach(async () => {
  await client.query("begin");
  partnerId = (
    await client.query(
      "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level) values ('limited.example', gen_random_uuid(), 'Limited', '[]', 'verified') returning id",
    )
  ).rows[0].id;
});
afterEach(() => client.query("rollback"));

const take = (domain = "limited.example", perHour = 500) =>
  client.query<{ wait: number }>("select public.take_rate_limit_token($1, $2) as wait", [domain, perHour]).then((r) => r.rows[0]!.wait);
const bucket = () => client.query("select tokens from public.federation_rate_limits where partner_id = $1", [partnerId]).then((r) => r.rows[0]);
/** Moves the bucket's clock back, as if that long had passed. */
const wait = (seconds: number) =>
  client.query("update public.federation_rate_limits set refilled_at = refilled_at - make_interval(secs => $2) where partner_id = $1", [
    partnerId,
    seconds,
  ]);

describe("api-design.md §Rate Limiting — the bucket in the database", () => {
  it("starts full: an hour's allowance can be spent as one burst, and then no more", async () => {
    // Taken in one statement, to keep 500 requests from being 500 round trips.
    const { rows } = await client.query(
      "select count(*) filter (where public.take_rate_limit_token('limited.example', 500) = 0)::int as allowed from generate_series(1, 500)",
    );
    expect(rows[0].allowed).toBe(500);
    expect(await take()).toBe(8);
  });

  it("says how long to wait, and waiting that long is enough — a refusal costs nothing", async () => {
    await client.query("select public.take_rate_limit_token('limited.example', 60) from generate_series(1, 60)");
    const seconds = await take("limited.example", 60);
    expect(seconds).toBe(60);
    expect(await take("limited.example", 60)).toBeGreaterThanOrEqual(59);
    await wait(seconds);
    expect(await take("limited.example", 60)).toBe(0);
  });

  it("never holds more than the hourly figure, however long a partner stays away", async () => {
    await take();
    await wait(30 * 24 * 3600);
    await take();
    expect((await bucket()).tokens).toBe(499);
  });

  it("a partner given its own figure is held to that, not to the default", async () => {
    await client.query("update public.federation_partners set rate_per_hour = 3 where id = $1", [partnerId]);
    expect([await take(), await take(), await take()]).toEqual([0, 0, 0]);
    expect(await take()).toBe(1200);
  });

  it("a partner removed between verification and counting is not an error", async () => {
    expect(await take("gone.example")).toBe(0);
  });

  it("buckets go with their partner", async () => {
    await take();
    await client.query("delete from public.federation_partners where id = $1", [partnerId]);
    expect((await client.query("select count(*)::int as n from public.federation_rate_limits where partner_id = $1", [partnerId])).rows[0].n).toBe(0);
  });

  it.each(["anon", "authenticated"])("%s can neither take a token nor read a bucket", async (role) => {
    for (const query of ["select public.take_rate_limit_token('limited.example', 500)", "select * from public.federation_rate_limits"]) {
      await client.query("savepoint as_role");
      await client.query(`set local role ${role}`);
      await expect(client.query(query)).rejects.toThrow(/permission denied/);
      await client.query("rollback to savepoint as_role");
    }
  });
});
