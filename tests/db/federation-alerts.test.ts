// Database lane: FP-11 and FP-13 alerts, and who sees and dismisses them. Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-000000000c01";
const ADMIN = "00000000-0000-4000-8000-000000000c02";

const client = new pg.Client(config);

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.role_permissions");
  await client.query("delete from public.federation_alerts");
  await client.query("set local session_replication_role = origin");
  await client.query("insert into auth.users (id, email) values ($1, 'super@node.example'), ($2, 'admin@node.example')", [SUPER_ADMIN, ADMIN]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin'), ($2, 'admin')", [SUPER_ADMIN, ADMIN]);
  // As the federation handlers raise it: the service role, no signed-in user.
  await client.query(
    "insert into public.federation_alerts (kind, domain, node_name) values ('first_contact', 'stranger.example', 'Stranger Yachts')",
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
    const { rows } = await client.query<T>(query, values);
    await client.query("reset role");
    await client.query("release savepoint as_user");
    return rows;
  } catch (error) {
    await client.query("rollback to savepoint as_user");
    throw error;
  }
}

const open = (userId: string) => asUser<{ id: string }>(userId, "select id from public.federation_alerts where resolved_at is null");

describe("FP-13 / FP-11 administrator alerts", () => {
  it("reach the holders of federation.notifications only", async () => {
    expect(await open(SUPER_ADMIN)).toHaveLength(1);
    expect(await open(ADMIN)).toHaveLength(0);
    await client.query("insert into public.role_permissions (role, permission) values ('admin', 'federation.notifications')");
    expect(await open(ADMIN)).toHaveLength(1);
  });

  it("stay until a recipient dismisses them, recording who did", async () => {
    const [alert] = await open(SUPER_ADMIN);
    await asUser(SUPER_ADMIN, "select public.resolve_federation_alert($1)", [alert!.id]);
    expect(await open(SUPER_ADMIN)).toHaveLength(0);
    const { rows } = await client.query("select resolved_by from public.federation_alerts where id = $1", [alert!.id]);
    expect(rows).toEqual([{ resolved_by: SUPER_ADMIN }]);
  });

  it("cannot be dismissed, raised or edited by anyone else", async () => {
    const [alert] = await open(SUPER_ADMIN);
    await expect(asUser(ADMIN, "select public.resolve_federation_alert($1)", [alert!.id])).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(SUPER_ADMIN, "insert into public.federation_alerts (kind, domain) values ('first_contact', 'x.example')"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asUser(SUPER_ADMIN, "update public.federation_alerts set resolved_at = now()")).rejects.toMatchObject({ code: "42501" });
  });
});
