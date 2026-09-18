// Database lane: the SQL that needs a real Postgres — RLS policies, the setup
// function, the Vault round-trip. Run with `pnpm test:db` against
// POSTGRES_URL_NON_POOLING / DATABASE_URL (migrations already applied).
//
// Every test runs inside a transaction that is rolled back, so the lane is
// safe to point at a shared development project: it leaves nothing behind,
// and it does not care whether that project has completed setup.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";
import { TEST_KEY } from "../federation/vectors";

// The same connection rules as the migration runner: verified TLS for any remote host.
const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const FIRST_USER = "00000000-0000-4000-8000-000000000001";
const SECOND_USER = "00000000-0000-4000-8000-000000000002";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";
const PRIVATE_SEED = Buffer.from(TEST_KEY.seedHex, "hex").toString("base64");

const client = new pg.Client(config);

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  // A clean slate inside the transaction, whatever state the database is in —
  // including a development project whose setup has been completed. Its real
  // administrator is the last super_admin, which the trigger under test would
  // (rightly) refuse to delete, so triggers are suspended for the clean-up
  // statements alone. `set local` and the deletes roll back with the rest.
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_partners");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.federation_keys");
  await client.query("update public.node_settings set node_uuid = null, identity_domain = null, identity_mode = null, setup_completed_at = null");
  await client.query("set local session_replication_role = origin");
  await client.query("insert into auth.users (id, email) values ($1, 'first@node.example'), ($2, 'second@node.example')", [FIRST_USER, SECOND_USER]);
});
afterEach(() => client.query("rollback"));

function completeSetup(adminUserId = FIRST_USER) {
  return client.query("select public.complete_setup($1, $2, $3, $4, $5, $6, $7)", [
    adminUserId,
    "node.example",
    "trial",
    NODE_UUID,
    TEST_KEY.keyId,
    TEST_KEY.publicKey,
    PRIVATE_SEED,
  ]);
}

/** Runs `query` as a signed-in user, the way a request carrying that user's JWT would. */
async function asUser<T extends pg.QueryResultRow>(userId: string, query: string): Promise<T[]> {
  await client.query("savepoint as_user");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
      userId,
    ]);
    return (await client.query<T>(query)).rows;
  } finally {
    await client.query("rollback to savepoint as_user");
  }
}

async function asRole<T extends pg.QueryResultRow>(role: "anon" | "service_role", query: string): Promise<T[]> {
  await client.query("savepoint as_role");
  try {
    await client.query(`set local role ${role}`);
    return (await client.query<T>(query)).rows;
  } finally {
    await client.query("rollback to savepoint as_role");
  }
}

describe("roles", () => {
  it("the migration seeds the five-role hierarchy, so a fresh database can hold its first administrator", async () => {
    const { rows } = await client.query("select name from public.roles order by rank desc");
    expect(rows.map((row) => row.name)).toEqual(["super_admin", "admin", "editor", "broker", "viewer"]);
  });

  it("the last super_admin can be neither demoted nor deleted", async () => {
    await completeSetup();
    await client.query("savepoint attempt");
    await expect(client.query("update public.user_roles set role = 'viewer' where user_id = $1", [FIRST_USER])).rejects.toThrow(
      /At least one super_admin/,
    );
    await client.query("rollback to savepoint attempt");
    await expect(client.query("delete from auth.users where id = $1", [FIRST_USER])).rejects.toThrow(/At least one super_admin/);
    await client.query("rollback to savepoint attempt");

    await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin')", [SECOND_USER]);
    await client.query("update public.user_roles set role = 'viewer' where user_id = $1", [FIRST_USER]);
  });

  it("a signed-in user reads only their own role, and cannot write any", async () => {
    await completeSetup();
    await client.query("insert into public.user_roles (user_id, role) values ($1, 'viewer')", [SECOND_USER]);

    expect(await asUser(SECOND_USER, "select user_id from public.user_roles")).toEqual([{ user_id: SECOND_USER }]);
    expect(await asUser(FIRST_USER, "select user_id from public.user_roles")).toHaveLength(2);
    await expect(asUser(SECOND_USER, "update public.user_roles set role = 'super_admin'")).rejects.toThrow(/permission denied/);
  });
});

describe("FP-5 first-run setup", () => {
  it("records the node UUID, the identity domain and the first administrator together", async () => {
    await completeSetup();
    const { rows } = await client.query("select node_uuid, identity_domain, identity_mode, setup_completed_at from public.node_settings");
    expect(rows[0]).toMatchObject({ node_uuid: NODE_UUID, identity_domain: "node.example", identity_mode: "trial" });
    expect(rows[0].setup_completed_at).not.toBeNull();
    expect((await client.query("select role from public.user_roles where user_id = $1", [FIRST_USER])).rows).toEqual([{ role: "super_admin" }]);
  });

  it("refuses to run twice, and the refused run changes nothing", async () => {
    await completeSetup();
    await client.query("savepoint attempt");
    await expect(completeSetup(SECOND_USER)).rejects.toThrow(/already been completed/);
    await client.query("rollback to savepoint attempt");
    expect((await client.query("select count(*)::int as n from public.federation_keys")).rows[0].n).toBe(1);
  });

  it("is not callable with the publishable key", async () => {
    await expect(asRole("anon", "select public.complete_setup(null, null, null, null, null, null, null)")).rejects.toThrow(/permission denied/);
  });
});

describe("FP-4 the private key is encrypted at rest", () => {
  it("federation_keys has no column that holds key material", async () => {
    const { rows } = await client.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'federation_keys'",
    );
    expect(rows.map((row) => row.column_name).sort()).toEqual(
      ["created_at", "id", "key_id", "private_key_secret_id", "public_key", "retired_at", "status"].sort(),
    );
  });

  it("the seed round-trips through Vault for the service role only", async () => {
    await completeSetup();
    expect(await asRole("service_role", "select key_id, private_key from public.active_signing_key()")).toEqual([
      { key_id: TEST_KEY.keyId, private_key: PRIVATE_SEED },
    ]);
    await expect(asRole("anon", "select * from public.active_signing_key()")).rejects.toThrow(/permission denied/);
    await expect(asUser(FIRST_USER, "select * from public.active_signing_key()")).rejects.toThrow(/permission denied/);
  });

  it("only a super_admin can read published key metadata", async () => {
    await completeSetup();
    await client.query("insert into public.user_roles (user_id, role) values ($1, 'admin')", [SECOND_USER]);
    expect(await asUser(FIRST_USER, "select key_id from public.federation_keys")).toEqual([{ key_id: TEST_KEY.keyId }]);
    expect(await asUser(SECOND_USER, "select key_id from public.federation_keys")).toEqual([]);
  });
});

// The migration states its own table privileges, so the node behaves the same
// whether or not the Supabase project was created with "Automatically expose
// new tables".
describe("table privileges do not depend on the project's settings", () => {
  const TABLES = ["roles", "user_roles", "node_settings", "federation_keys"];

  it.each(TABLES)("the publishable key alone cannot read public.%s", async (table) => {
    await expect(asRole("anon", `select * from public.${table}`)).rejects.toThrow(/permission denied/);
  });

  it.each(TABLES)("the service role — the federation and setup trust domain — can read public.%s", async (table) => {
    await expect(asRole("service_role", `select * from public.${table}`)).resolves.toBeDefined();
  });

  it.each(TABLES)("a signed-in user has no write privilege on public.%s", async (table) => {
    await completeSetup();
    await expect(asUser(FIRST_USER, `delete from public.${table}`)).rejects.toThrow(/permission denied/);
  });
});
