// Database lane: the permission matrix. Every test rolls back.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-000000000b01";
const ADMIN = "00000000-0000-4000-8000-000000000b02";
const EDITOR = "00000000-0000-4000-8000-000000000b03";
const BROKER = "00000000-0000-4000-8000-000000000b04";
const VIEWER = "00000000-0000-4000-8000-000000000b05";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abd0";

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
  // The shipped defaults, whatever this database's matrix has been edited to.
  await client.query("delete from public.role_permissions");
  await client.query(
    `insert into public.role_permissions (role, permission) values
       ('admin', 'users.manage'), ('admin', 'listings.manage'), ('admin', 'activity-log.view'), ('admin', 'api-keys.manage'),
       ('editor', 'listings.manage'), ('broker', 'listings.manage_own')`,
  );
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'super@node.example'), ($2, 'admin@node.example'), ($3, 'editor@node.example'),
       ($4, 'broker@node.example'), ($5, 'viewer@node.example')`,
    [SUPER_ADMIN, ADMIN, EDITOR, BROKER, VIEWER],
  );
  const key = newKey();
  await client.query("select public.complete_setup($1, 'node.example', 'trial', $2, $3, $4, $5)", [
    SUPER_ADMIN,
    NODE_UUID,
    key.keyId,
    key.publicKey,
    key.seed,
  ]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'editor'), ($3, 'broker'), ($4, 'viewer')", [
    ADMIN,
    EDITOR,
    BROKER,
    VIEWER,
  ]);
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
    const { rows } = await client.query<T>(query, values);
    await client.query("reset role");
    await client.query("release savepoint as_user");
    return rows;
  } catch (error) {
    await client.query("rollback to savepoint as_user");
    throw error;
  }
}

const permissionsOf = (userId: string) =>
  asUser<{ my_permissions: string }>(userId, "select public.my_permissions()").then((rows) => rows.map((row) => row.my_permissions));
const setPermissions = (actor: string, role: string, permissions: string[]) =>
  asUser(actor, "select public.set_role_permissions($1, $2)", [role, permissions]);

describe("The default matrix", () => {
  it("reproduces what the ranks allowed", async () => {
    expect(await permissionsOf(SUPER_ADMIN)).toEqual([
      "users.manage",
      "roles.manage",
      "listings.manage",
      "listings.manage_own",
      "federation.manage",
      "federation.notifications",
      "activity-log.view",
      "api-keys.manage",
    ]);
    expect(await permissionsOf(ADMIN)).toEqual(["users.manage", "listings.manage", "activity-log.view", "api-keys.manage"]);
    expect(await permissionsOf(EDITOR)).toEqual(["listings.manage"]);
    expect(await permissionsOf(BROKER)).toEqual(["listings.manage_own"]);
    expect(await permissionsOf(VIEWER)).toEqual([]);
  });
});

describe("Editing the matrix", () => {
  it("changes what a role may do at once, and records the change", async () => {
    expect(await asUser(EDITOR, "select key_id from public.federation_keys")).toHaveLength(0);
    await setPermissions(SUPER_ADMIN, "editor", ["listings.manage", "federation.manage"]);
    expect(await asUser(EDITOR, "select key_id from public.federation_keys")).toHaveLength(1);

    await setPermissions(SUPER_ADMIN, "editor", ["federation.manage"]);
    const { rows } = await client.query(
      "select role, added, removed, changed_by_email from public.role_permission_events where changed_by = $1 order by id",
      [SUPER_ADMIN],
    );
    expect(rows).toEqual([
      { role: "editor", added: ["federation.manage"], removed: [], changed_by_email: "super@node.example" },
      { role: "editor", added: [], removed: ["listings.manage"], changed_by_email: "super@node.example" },
    ]);
  });

  it("never touches super_admin, which holds everything", async () => {
    await expect(setPermissions(SUPER_ADMIN, "super_admin", [])).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("insert into public.role_permissions values ('super_admin', 'users.manage')")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("needs roles.manage", async () => {
    await expect(setPermissions(ADMIN, "viewer", [])).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ADMIN, "insert into public.role_permissions values ('viewer', 'users.manage')")).rejects.toMatchObject({ code: "42501" });
  });

  describe("given to an admin", () => {
    beforeEach(() => setPermissions(SUPER_ADMIN, "admin", ["users.manage", "roles.manage", "listings.manage", "activity-log.view"]));

    it("edits roles below admin, with permissions the admin holds", async () => {
      await setPermissions(ADMIN, "viewer", ["activity-log.view"]);
      expect(await permissionsOf(VIEWER)).toEqual(["activity-log.view"]);
    });

    it("cannot edit its own role or grant what it does not hold", async () => {
      await expect(setPermissions(ADMIN, "admin", ["federation.manage"])).rejects.toMatchObject({ code: "42501" });
      await expect(setPermissions(ADMIN, "editor", ["listings.manage", "federation.manage"])).rejects.toMatchObject({ code: "42501" });
      expect(await permissionsOf(EDITOR)).toEqual(["listings.manage"]);
    });
  });

  it("refuses a permission that does not exist", async () => {
    await expect(setPermissions(SUPER_ADMIN, "viewer", ["everything"])).rejects.toMatchObject({ code: "P0001" });
  });
});

describe("What the permissions open", () => {
  it("lets a role with users.manage list accounts, whatever its rank", async () => {
    await expect(asUser(EDITOR, "select * from public.list_users()")).rejects.toMatchObject({ code: "42501" });
    await setPermissions(SUPER_ADMIN, "editor", ["listings.manage", "users.manage"]);
    expect((await asUser(EDITOR, "select * from public.list_users()")).length).toBeGreaterThan(0);
    // The hierarchy still holds: an editor manages only brokers and viewers.
    const ask = (id: string) => asUser<{ ok: boolean }>(EDITOR, "select public.can_manage_user($1) as ok", [id]).then((r) => r[0]!.ok);
    expect(await ask(VIEWER)).toBe(true);
    expect(await ask(ADMIN)).toBe(false);
  });

  it("opens the request log to activity-log.view", async () => {
    await client.query(
      "insert into public.federation_request_log (request_id, sender_domain, method, path, outcome, http_status) values ('permissions-test', 'peer.example', 'GET', '/x', 'ok', 200)",
    );
    const mine = "select 1 from public.federation_request_log where request_id = 'permissions-test'";
    expect(await asUser(VIEWER, mine)).toHaveLength(0);
    await setPermissions(SUPER_ADMIN, "viewer", ["activity-log.view"]);
    expect(await asUser(VIEWER, mine)).toHaveLength(1);
  });
});
