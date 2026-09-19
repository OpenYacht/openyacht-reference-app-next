// Database lane: rotating the signing key. Needs Supabase Vault. Every test rolls back.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000e1";
const EDITOR = "00000000-0000-4000-8000-0000000000e2";
const NODE_UUID = "018f3c2e-4b6a-7d8e-9f01-23456789abcd";

const client = new pg.Client(config);

/** Real key material: the table checks the shape of both the key ID and the public key. */
function newKey() {
  const raw = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    keyId: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    publicKey: raw.toString("base64"),
    seed: randomBytes(32).toString("base64"),
  };
}
const first = newKey();

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
  await client.query("insert into auth.users (id, email) values ($1, 'admin@node.example'), ($2, 'editor@node.example')", [SUPER_ADMIN, EDITOR]);
  await client.query("select public.complete_setup($1, 'node.example', 'trial', $2, $3, $4, $5)", [
    SUPER_ADMIN,
    NODE_UUID,
    first.keyId,
    first.publicKey,
    first.seed,
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

const rotate = (key: ReturnType<typeof newKey>, emergency: boolean, userId = SUPER_ADMIN) =>
  asUser(userId, "select public.rotate_signing_key($1, $2, $3, $4, $5)", [
    key.keyId,
    key.publicKey,
    key.seed,
    emergency,
    emergency ? "Laptop holding a database backup was stolen." : null,
  ]);
const published = () =>
  client.query<{ key_id: string }>("select key_id from public.published_signing_keys()").then((r) => r.rows.map((row) => row.key_id));
const signingKey = () => client.query<{ key_id: string; private_key: string }>("select * from public.active_signing_key()").then((r) => r.rows[0]!);
const statusOf = (keyId: string) =>
  client
    .query<{ status: string; overlap_hours: number | null; has_seed: boolean }>(
      `select k.status, round(extract(epoch from k.overlap_ends_at - k.retired_at) / 3600)::int as overlap_hours,
              exists (select 1 from vault.secrets s where s.name = 'openyacht_signing_key_' || k.key_id) as has_seed
         from public.federation_keys k where k.key_id = $1`,
      [keyId],
    )
    .then((r) => r.rows[0]!);

describe("routine rotation: no coordination, no outage", () => {
  it("publishes the new key alongside the old one, signs with the new one at once, and keeps the old one for 48 hours", async () => {
    const second = newKey();
    await rotate(second, false);
    expect(await published()).toEqual([second.keyId, first.keyId]);
    expect(await signingKey()).toEqual({ key_id: second.keyId, private_key: second.seed });
    expect(await statusOf(first.keyId)).toEqual({ status: "retiring", overlap_hours: 48, has_seed: true });
  });

  it("stops publishing the old key when its overlap ends — whether or not anything has revoked it yet", async () => {
    const second = newKey();
    await rotate(second, false);
    await client.query(
      "update public.federation_keys set retired_at = now() - interval '49 hours', overlap_ends_at = now() - interval '1 hour' where key_id = $1",
      [first.keyId],
    );
    expect(await published()).toEqual([second.keyId]);
    expect((await statusOf(first.keyId)).status).toBe("retiring");

    // Then the tidy-up: revoked, and its seed destroyed.
    expect((await client.query("select public.expire_retiring_keys() as n")).rows[0].n).toBe(1);
    expect(await statusOf(first.keyId)).toEqual({ status: "revoked", overlap_hours: null, has_seed: false });
    expect((await client.query("select public.expire_retiring_keys() as n")).rows[0].n).toBe(0);
  });

  it("a second rotation inside the overlap keeps both older keys published until each runs out", async () => {
    const second = newKey();
    const third = newKey();
    await rotate(second, false);
    await rotate(third, false);
    expect(await published()).toEqual([third.keyId, second.keyId, first.keyId]);
    expect((await signingKey()).key_id).toBe(third.keyId);
  });
});

describe("emergency rotation: no overlap", () => {
  it("revokes the old key there and then, and destroys its seed", async () => {
    const second = newKey();
    await rotate(second, true);
    expect(await published()).toEqual([second.keyId]);
    expect(await statusOf(first.keyId)).toEqual({ status: "revoked", overlap_hours: null, has_seed: false });
    expect(await signingKey()).toEqual({ key_id: second.keyId, private_key: second.seed });
  });

  it("is documented: it needs a note, and the note stays with the key it replaced", async () => {
    const second = newKey();
    await expect(
      asUser(SUPER_ADMIN, "select public.rotate_signing_key($1, $2, $3, true, '  ')", [second.keyId, second.publicKey, second.seed]),
    ).rejects.toThrow(/needs a note/);
    await rotate(second, true);
    const { rows } = await client.query("select rotation_note from public.federation_keys where key_id = $1", [first.keyId]);
    expect(rows[0].rotation_note).toBe("Laptop holding a database backup was stolen.");
  });

  it("takes keys still retiring from an earlier rotation with it", async () => {
    const second = newKey();
    const third = newKey();
    await rotate(second, false);
    await rotate(third, true);
    expect(await published()).toEqual([third.keyId]);
    expect((await statusOf(first.keyId)).status).toBe("revoked");
    expect((await statusOf(second.keyId)).status).toBe("revoked");
  });
});

describe("what holds whatever happens", () => {
  it("exactly one key signs", async () => {
    const stray = newKey();
    await client.query("savepoint stray");
    await expect(
      client.query("insert into public.federation_keys (key_id, public_key, private_key_secret_id) values ($1, $2, gen_random_uuid())", [
        stray.keyId,
        stray.publicKey,
      ]),
    ).rejects.toThrow(/federation_keys_one_active/);
    await client.query("rollback to savepoint stray");
  });

  it("only a super admin rotates", async () => {
    await expect(rotate(newKey(), false, EDITOR)).rejects.toThrow(/Only a super admin/);
    await expect(rotate(newKey(), true, EDITOR)).rejects.toThrow(/Only a super admin/);
    expect(await published()).toEqual([first.keyId]);
  });

  it("the seed never reaches a signed-in user, and the housekeeping functions are not theirs to call", async () => {
    for (const query of [
      "select * from public.active_signing_key()",
      "select public.expire_retiring_keys()",
      "select * from public.published_signing_keys()",
    ]) {
      await expect(asUser(SUPER_ADMIN, query)).rejects.toThrow(/permission denied/);
    }
  });

  it("refuses an overlap that is no overlap, or that never ends", async () => {
    const key = newKey();
    for (const hours of [0, 24 * 15]) {
      await expect(
        asUser(SUPER_ADMIN, "select public.rotate_signing_key($1, $2, $3, false, null, $4)", [key.keyId, key.publicKey, key.seed, hours]),
      ).rejects.toThrow(/overlap must be/);
    }
  });
});
