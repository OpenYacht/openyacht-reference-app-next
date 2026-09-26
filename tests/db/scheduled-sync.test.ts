// Database lane: the hourly sync job. Needs pg_cron, pg_net and Supabase Vault.
// Every test rolls back, so no job is left registered and no request is sent:
// pg_net only sends what a committed transaction queued.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000f1";
const EDITOR = "00000000-0000-4000-8000-0000000000f2";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abce";
const SECRET = "a".repeat(64);

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
  // And no schedule, even on a database that has one registered.
  await client.query("select public.unschedule_sync()");
  await client.query("insert into auth.users (id, email) values ($1, 'admin@node.example'), ($2, 'editor@node.example')", [SUPER_ADMIN, EDITOR]);
  const key = newKey();
  await client.query("select public.complete_setup($1, 'node.example', 'trial', $2, $3, $4, $5)", [
    SUPER_ADMIN,
    NODE_UUID,
    key.keyId,
    key.publicKey,
    key.seed,
  ]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'editor')", [EDITOR]);
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

const schedule = (secret = SECRET, userId = SUPER_ADMIN) =>
  asUser<{ minute: number }>(userId, "select public.schedule_sync($1) as minute", [secret]).then((rows) => rows[0]!.minute);
const job = () =>
  client
    .query<{ schedule: string; command: string; active: boolean }>("select schedule, command, active from cron.job where jobname = 'openyacht-sync'")
    .then((r) => r.rows);
const storedSecrets = () => client.query("select 1 from vault.secrets where name = 'openyacht_internal_api_secret'").then((r) => r.rowCount);

describe("Scheduled sync registration", () => {
  it("registers one hourly job whose SQL never contains the secret", async () => {
    const minute = await schedule();
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThanOrEqual(59);
    expect(await job()).toEqual([{ schedule: `${minute} * * * *`, command: "select private.request_sync()", active: true }]);
    expect(await storedSecrets()).toBe(1);
  });

  it("keeps its minute and replaces the secret when registered again", async () => {
    const minute = await schedule();
    const again = await schedule("b".repeat(64));
    expect(again).toBe(minute);
    expect(await job()).toHaveLength(1);
    expect(await storedSecrets()).toBe(1);
    const [status] = await asUser<{ secret_sha256: string }>(SUPER_ADMIN, "select secret_sha256 from public.sync_schedule_status()");
    expect(status!.secret_sha256).toBe(createHash("sha256").update("b".repeat(64)).digest("hex"));
  });

  it("is refused to anyone but a super admin", async () => {
    await expect(schedule(SECRET, EDITOR)).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(EDITOR, "select * from public.sync_schedule_status()")).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(EDITOR, "select public.unschedule_sync()")).rejects.toMatchObject({ code: "42501" });
    expect(await job()).toHaveLength(0);
  });

  it("refuses a blank secret", async () => {
    await expect(schedule("   ")).rejects.toMatchObject({ code: "P0001" });
  });

  it("refuses before setup has been completed", async () => {
    await client.query("update public.node_settings set setup_completed_at = null");
    await expect(schedule()).rejects.toMatchObject({ code: "P0001" });
  });

  it("removes the job and destroys the secret when stopped", async () => {
    await schedule();
    await asUser(SUPER_ADMIN, "select public.unschedule_sync()");
    expect(await job()).toHaveLength(0);
    expect(await storedSecrets()).toBe(0);
    expect(await asUser(SUPER_ADMIN, "select * from public.sync_schedule_status()")).toHaveLength(0);
  });

  it("is not callable by anonymous clients", async () => {
    await client.query("savepoint anon");
    await client.query("set local role anon");
    await expect(client.query("select public.schedule_sync('x')")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint anon");
  });
});

describe("Scheduled sync request", () => {
  it("posts to the sync route on the identity domain with the stored secret", async () => {
    await schedule();
    const { rows } = await client.query<{ id: string }>("select private.request_sync() as id");
    const { rows: queued } = await client.query<{ method: string; url: string; headers: Record<string, string> }>(
      "select method, url, headers from net.http_request_queue where id = $1",
      [rows[0]!.id],
    );
    expect(queued).toEqual([
      { method: "POST", url: "https://node.example/api/internal/sync", headers: expect.objectContaining({ authorization: `Bearer ${SECRET}` }) },
    ]);
    const [status] = await asUser<{ last_requested_at: Date | null; last_status_code: number | null }>(
      SUPER_ADMIN,
      "select last_requested_at, last_status_code from public.sync_schedule_status()",
    );
    expect(status!.last_requested_at).not.toBeNull();
    // Nothing is sent before the transaction commits, so there is no answer yet.
    expect(status!.last_status_code).toBeNull();
  });

  it("sends nothing when no schedule is registered", async () => {
    const { rows } = await client.query<{ id: string | null }>("select private.request_sync() as id");
    expect(rows[0]!.id).toBeNull();
  });
});
