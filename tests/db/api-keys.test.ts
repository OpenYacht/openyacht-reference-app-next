// Database lane: data API keys — stored as digests, rate-limited per key,
// managed with api-keys.manage. Every test rolls back.
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const ADMIN = "00000000-0000-4000-8000-000000000f11";
const EDITOR = "00000000-0000-4000-8000-000000000f12";
const KEY = "oyk_test-key-that-is-long-enough-to-be-plausible";
const HASH = createHash("sha256").update(KEY).digest("hex");

const client = new pg.Client(config);

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.role_permissions");
  await client.query("set local session_replication_role = origin");
  await client.query("insert into public.role_permissions (role, permission) values ('admin', 'api-keys.manage')");
  await client.query("insert into auth.users (id, email) values ($1, 'a@node.example'), ($2, 'e@node.example')", [ADMIN, EDITOR]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'editor')", [ADMIN, EDITOR]);
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

const create = (rate = 60) =>
  asUser(ADMIN, "select public.create_api_key('Website', 'oyk_test-ke', $1, $2) as id", [HASH, rate]).then((r) => r[0].id);
const use = () => client.query("select * from public.use_api_key($1)", [HASH]).then((r) => r.rows);

describe("data API keys", () => {
  it("authenticate by digest and carry their scopes", async () => {
    await create();
    expect(await use()).toEqual([{ key_id: expect.any(String), scopes: ["yachts:read"], retry_after: 0 }]);
    expect(
      await client.query("select * from public.use_api_key($1)", [createHash("sha256").update("wrong").digest("hex")]).then((r) => r.rows),
    ).toEqual([]);
  });

  it("are limited per key, with a wait that a refused request does not lengthen", async () => {
    await create(2);
    expect((await use())[0].retry_after).toBe(0);
    expect((await use())[0].retry_after).toBe(0);
    const refused = (await use())[0].retry_after;
    expect(refused).toBeGreaterThan(0);
    expect((await use())[0].retry_after).toBeLessThanOrEqual(refused);
  });

  it("stop working when revoked", async () => {
    const id = await create();
    await asUser(ADMIN, "select public.revoke_api_key($1)", [id]);
    expect(await use()).toEqual([]);
  });

  it("are managed with api-keys.manage only, and their digests are not readable", async () => {
    await expect(asUser(EDITOR, "select public.create_api_key('X', 'x', $1)", [HASH])).rejects.toMatchObject({ code: "42501" });
    await create();
    expect(await asUser(ADMIN, "select name from public.api_keys where prefix = 'oyk_test-ke'")).toEqual([{ name: "Website" }]);
    await expect(asUser(ADMIN, "select key_hash from public.api_keys")).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ADMIN, "select * from public.use_api_key($1)", [HASH])).rejects.toMatchObject({ code: "42501" });
  });
});
