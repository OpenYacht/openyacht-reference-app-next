// Database lane: who may give, change and take away roles. Every test rolls back.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-000000000a01";
const SECOND_SUPER_ADMIN = "00000000-0000-4000-8000-000000000a02";
const ADMIN = "00000000-0000-4000-8000-000000000a03";
const OTHER_ADMIN = "00000000-0000-4000-8000-000000000a04";
const EDITOR = "00000000-0000-4000-8000-000000000a05";
const NEWCOMER = "00000000-0000-4000-8000-000000000a06";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcf";

const client = new pg.Client(config);

function newKey() {
  const raw = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    keyId: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    publicKey: raw.toString("base64"),
    seed: randomBytes(32).toString("base64"),
  };
}

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  // A node set up a moment ago, whatever the database held: see node-core.test.ts.
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_partners");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.federation_keys");
  await client.query("update public.node_settings set node_uuid = null, identity_domain = null, identity_mode = null, setup_completed_at = null");
  await client.query("set local session_replication_role = origin");
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'super@node.example'), ($2, 'super2@node.example'), ($3, 'admin@node.example'),
       ($4, 'admin2@node.example'), ($5, 'editor@node.example'), ($6, 'new@node.example')`,
    [SUPER_ADMIN, SECOND_SUPER_ADMIN, ADMIN, OTHER_ADMIN, EDITOR, NEWCOMER],
  );
  const key = newKey();
  await client.query("select public.complete_setup($1, 'node.example', 'trial', $2, $3, $4, $5)", [
    SUPER_ADMIN,
    NODE_UUID,
    key.keyId,
    key.publicKey,
    key.seed,
  ]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin'), ($2, 'admin'), ($3, 'admin'), ($4, 'editor')", [
    SECOND_SUPER_ADMIN,
    ADMIN,
    OTHER_ADMIN,
    EDITOR,
  ]);
});
afterEach(() => client.query("rollback"));

async function asUser<T extends pg.QueryResultRow>(userId: string, query: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  await client.query("savepoint as_user");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
      userId,
    ]);
    const result = await client.query<T>(query, values);
    await client.query("reset role");
    await client.query("release savepoint as_user");
    return result;
  } catch (error) {
    await client.query("rollback to savepoint as_user");
    throw error;
  }
}

const give = (actor: string, userId: string, role: string) =>
  asUser(actor, "insert into public.user_roles (user_id, role) values ($1, $2)", [userId, role]);
/** Row count, not an error: a policy's USING clause filters rows silently. */
const change = (actor: string, userId: string, role: string) =>
  asUser(actor, "update public.user_roles set role = $2 where user_id = $1", [userId, role]).then((r) => r.rowCount);
const remove = (actor: string, userId: string) => asUser(actor, "delete from public.user_roles where user_id = $1", [userId]).then((r) => r.rowCount);
const roleOf = (userId: string) =>
  client.query<{ role: string }>("select role from public.user_roles where user_id = $1", [userId]).then((r) => r.rows[0]?.role ?? null);

describe("Giving a role", () => {
  it("lets an admin give a role below their own, and stamps who did it", async () => {
    await give(ADMIN, NEWCOMER, "editor");
    const { rows } = await client.query("select role, assigned_by from public.user_roles where user_id = $1", [NEWCOMER]);
    expect(rows).toEqual([{ role: "editor", assigned_by: ADMIN }]);
  });

  it("refuses an admin a role equal to or above their own", async () => {
    await expect(give(ADMIN, NEWCOMER, "admin")).rejects.toMatchObject({ code: "42501" });
    await expect(give(ADMIN, NEWCOMER, "super_admin")).rejects.toMatchObject({ code: "42501" });
  });

  it("lets only a super admin make a super admin", async () => {
    await give(SUPER_ADMIN, NEWCOMER, "super_admin");
    expect(await roleOf(NEWCOMER)).toBe("super_admin");
  });

  it("refuses everyone below admin", async () => {
    await expect(give(EDITOR, NEWCOMER, "viewer")).rejects.toMatchObject({ code: "42501" });
  });

  it("does not let a client name someone else as the assigner", async () => {
    await expect(
      asUser(ADMIN, "insert into public.user_roles (user_id, role, assigned_by) values ($1, 'viewer', $2)", [NEWCOMER, SUPER_ADMIN]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Changing and removing a role", () => {
  it("lets an admin move an editor down and remove them", async () => {
    expect(await change(ADMIN, EDITOR, "broker")).toBe(1);
    expect(await roleOf(EDITOR)).toBe("broker");
    expect(await remove(ADMIN, EDITOR)).toBe(1);
    expect(await roleOf(EDITOR)).toBeNull();
  });

  it("does not let an admin promote anyone to their own rank", async () => {
    await expect(change(ADMIN, EDITOR, "admin")).rejects.toMatchObject({ code: "42501" });
  });

  it("does not let an admin touch another admin or a super admin", async () => {
    expect(await change(ADMIN, OTHER_ADMIN, "viewer")).toBe(0);
    expect(await remove(ADMIN, OTHER_ADMIN)).toBe(0);
    expect(await remove(ADMIN, SUPER_ADMIN)).toBe(0);
    expect(await roleOf(OTHER_ADMIN)).toBe("admin");
  });

  it("does not let anyone change or remove their own role", async () => {
    expect(await change(ADMIN, ADMIN, "viewer")).toBe(0);
    expect(await change(SUPER_ADMIN, SUPER_ADMIN, "admin")).toBe(0);
    expect(await remove(SUPER_ADMIN, SUPER_ADMIN)).toBe(0);
    expect(await roleOf(SUPER_ADMIN)).toBe("super_admin");
  });

  it("lets a super admin demote another super admin, but never the last one", async () => {
    expect(await change(SUPER_ADMIN, SECOND_SUPER_ADMIN, "admin")).toBe(1);
    // The one left cannot act on itself, so the last-super-admin trigger is
    // the backstop for anything that bypasses the policies.
    await expect(client.query("delete from public.user_roles where user_id = $1", [SUPER_ADMIN])).rejects.toMatchObject({ code: "P0001" });
  });
});

describe("The record of role changes", () => {
  it("records every change with who made it", async () => {
    await give(ADMIN, NEWCOMER, "viewer");
    await change(ADMIN, NEWCOMER, "broker");
    await remove(ADMIN, NEWCOMER);
    const { rows } = await client.query(
      "select user_email, old_role, new_role, changed_by_email from public.user_role_events where user_id = $1 order by id",
      [NEWCOMER],
    );
    expect(rows).toEqual([
      { user_email: "new@node.example", old_role: null, new_role: "viewer", changed_by_email: "admin@node.example" },
      { user_email: "new@node.example", old_role: "viewer", new_role: "broker", changed_by_email: "admin@node.example" },
      { user_email: "new@node.example", old_role: "broker", new_role: null, changed_by_email: "admin@node.example" },
    ]);
  });

  it("is readable by admins only and writable by nobody", async () => {
    await give(ADMIN, NEWCOMER, "viewer");
    expect((await asUser(ADMIN, "select 1 from public.user_role_events where user_id = $1", [NEWCOMER])).rowCount).toBe(1);
    expect((await asUser(EDITOR, "select 1 from public.user_role_events")).rowCount).toBe(0);
    await expect(asUser(SUPER_ADMIN, "delete from public.user_role_events")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("Listing accounts", () => {
  it("shows admins every account, and which ones they may manage", async () => {
    const { rows } = await asUser<{ email: string; role: string | null; manageable: boolean }>(
      ADMIN,
      // Only this test's accounts: the database may hold others.
      "select email, role, manageable from public.list_users() where id = any($1::uuid[])",
      [[SUPER_ADMIN, SECOND_SUPER_ADMIN, ADMIN, OTHER_ADMIN, EDITOR, NEWCOMER]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.email, [row.role, row.manageable]]))).toEqual({
      "super@node.example": ["super_admin", false],
      "super2@node.example": ["super_admin", false],
      "admin@node.example": ["admin", false],
      "admin2@node.example": ["admin", false],
      "editor@node.example": ["editor", true],
      "new@node.example": [null, true],
    });
  });

  it("is refused to anyone below admin", async () => {
    await expect(asUser(EDITOR, "select * from public.list_users()")).rejects.toMatchObject({ code: "42501" });
  });

  it("answers the pre-flight checks the application makes before using the Auth admin API", async () => {
    const ask = (actor: string, query: string, value: string) =>
      asUser<{ ok: boolean }>(actor, `select ${query}($1) as ok`, [value]).then((r) => r.rows[0]!.ok);
    expect(await ask(ADMIN, "public.can_manage_user", EDITOR)).toBe(true);
    expect(await ask(ADMIN, "public.can_manage_user", OTHER_ADMIN)).toBe(false);
    expect(await ask(SUPER_ADMIN, "public.can_manage_user", SUPER_ADMIN)).toBe(false);
    expect(await ask(ADMIN, "public.can_assign_role", "editor")).toBe(true);
    expect(await ask(ADMIN, "public.can_assign_role", "admin")).toBe(false);
    expect(await ask(SUPER_ADMIN, "public.can_assign_role", "no_such_role")).toBe(false);
  });
});
