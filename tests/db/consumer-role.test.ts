// Database lane: partners and listing copies — row level security, privileges
// and the constraints that protect provenance. Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000a1";
const ADMIN = "00000000-0000-4000-8000-0000000000a2";
const VIEWER = "00000000-0000-4000-8000-0000000000a3";
const NO_ROLE = "00000000-0000-4000-8000-0000000000a4";
const URI = "https://authority.example/openyacht/v1/listings/018f6d2e-9f0a-7cc3-a1b2-000000000001";

const client = new pg.Client(config);
let partnerId: string;

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_partners");
  await client.query(
    "insert into auth.users (id, email) values ($1, 'sa@node.example'), ($2, 'a@node.example'), ($3, 'v@node.example'), ($4, 'n@node.example')",
    [SUPER_ADMIN, ADMIN, VIEWER, NO_ROLE],
  );
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin'), ($2, 'admin'), ($3, 'viewer')", [
    SUPER_ADMIN,
    ADMIN,
    VIEWER,
  ]);
  const { rows } = await client.query(
    `insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level)
     values ('authority.example', '018f3c2e-4b6a-7d8e-9f01-23456789abcd', 'Authority Yachts', '[]', 'verified') returning id`,
  );
  partnerId = rows[0].id;
  await client.query(
    `insert into public.listing_copies (canonical_uri, partner_id, listing_type, status, listing_updated_at, payload, provenance)
     values ($1, $2, 'sale', 'active', '2026-09-01T10:00:00Z', '{"id": "x"}', '{"authority": "authority.example"}')`,
    [URI, partnerId],
  );
});
afterEach(() => client.query("rollback"));

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

async function attempt(query: string, values: unknown[] = []) {
  await client.query("savepoint attempt");
  try {
    await client.query(query, values);
    return null;
  } catch (error) {
    await client.query("rollback to savepoint attempt");
    return (error as Error).message;
  }
}

describe("partners are federation configuration", () => {
  it("a super_admin reads and manages partners as themselves, under RLS", async () => {
    expect(await asUser(SUPER_ADMIN, "select domain from public.federation_partners")).toEqual([{ domain: "authority.example" }]);
    expect(await asUser(SUPER_ADMIN, "update public.federation_partners set acceptance_policy = 'accept_all' returning acceptance_policy")).toEqual([
      { acceptance_policy: "accept_all" },
    ]);
  });

  it.each([
    ["an admin", ADMIN],
    ["a viewer", VIEWER],
    ["a signed-in user with no role", NO_ROLE],
  ])("%s sees no partners and changes none", async (_label, user) => {
    expect(await asUser(user, "select domain from public.federation_partners")).toEqual([]);
    expect(await asUser(user, "update public.federation_partners set trust_level = 'blocked' returning id")).toEqual([]);
    await expect(
      asUser(
        user,
        "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level) values ('x.example', gen_random_uuid(), 'X', '[]', 'verified')",
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("new partners hold their listings for review until a policy is chosen", async () => {
    const { rows } = await client.query("select acceptance_policy from public.federation_partners");
    expect(rows).toEqual([{ acceptance_policy: "hold" }]);
  });

  it("a domain is stored lowercase and only once", async () => {
    const insert =
      "insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level) values ($1, gen_random_uuid(), 'X', '[]', 'verified')";
    expect(await attempt(insert, ["Authority.Example"])).toMatch(/check constraint/);
    expect(await attempt(insert, ["authority.example"])).toMatch(/duplicate key/);
  });
});

describe("ID-5 nobody edits a copy", () => {
  it("role holders read copies; a user with no role reads none", async () => {
    for (const user of [SUPER_ADMIN, ADMIN, VIEWER]) expect(await asUser(user, "select canonical_uri from public.listing_copies")).toHaveLength(1);
    expect(await asUser(NO_ROLE, "select canonical_uri from public.listing_copies")).toEqual([]);
  });

  it("no signed-in user — not even a super_admin — can write one", async () => {
    await expect(asUser(SUPER_ADMIN, "update public.listing_copies set status = 'sold'")).rejects.toThrow(/permission denied/);
    await expect(asUser(SUPER_ADMIN, "delete from public.listing_copies")).rejects.toThrow(/permission denied/);
  });
});

describe("ID-3 the partner record anchors provenance", () => {
  it("a partner that has delivered listings cannot be deleted", async () => {
    expect(await attempt("delete from public.federation_partners where id = $1", [partnerId])).toMatch(/foreign key constraint/);
  });

  it("a partner that has delivered nothing can", async () => {
    await client.query("delete from public.listing_copies");
    expect(await attempt("delete from public.federation_partners where id = $1", [partnerId])).toBeNull();
  });
});

describe("ID-7 / ID-10 an ended listing keeps no payload", () => {
  it("rejects a tombstoned copy that still carries its payload", async () => {
    expect(await attempt("update public.listing_copies set tombstoned_at = '2026-09-05T09:30:00Z'")).toMatch(/listing_copies_ended_has_no_payload/);
    expect(await attempt("update public.listing_copies set tombstoned_at = '2026-09-05T09:30:00Z', payload = null")).toBeNull();
  });
});

describe("the publishable key alone reaches nothing", () => {
  it.each(["federation_partners", "listing_copies"])("anon cannot read public.%s", async (table) => {
    await client.query("savepoint as_anon");
    await client.query("set local role anon");
    await expect(client.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint as_anon");
  });
});
