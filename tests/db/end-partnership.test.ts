// Database lane: ID-10 — ending a partnership ends the use of the listings
// whose terms say so. Every test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const SUPER_ADMIN = "00000000-0000-4000-8000-000000000d01";
const EDITOR = "00000000-0000-4000-8000-000000000d02";
const uri = (domain: string, n: number) => `https://${domain}/openyacht/v1/listings/018f6d2e-9f0a-7cc3-a1b2-00000000000${n}`;

const client = new pg.Client(config);
let ending: string;
let other: string;

beforeAll(() => client.connect());
afterAll(() => client.end());

async function copy(partnerId: string, canonicalUri: string, payload: object | null, extra: { tombstoned?: boolean; identifiers?: string[] } = {}) {
  await client.query(
    `insert into public.listing_copies (canonical_uri, partner_id, listing_type, status, listing_updated_at, payload, provenance,
                                        tombstoned_at, display_state, hard_identifiers, in_conflict)
     values ($1, $2, 'sale', 'active', '2026-09-01T10:00:00Z', $3, '{}', $4, 'published', $5, $6)`,
    [
      canonicalUri,
      partnerId,
      payload === null ? null : JSON.stringify(payload),
      extra.tombstoned ? "2026-09-02T10:00:00Z" : null,
      extra.identifiers ?? [],
      (extra.identifiers ?? []).length > 0,
    ],
  );
}

beforeEach(async () => {
  await client.query("begin");
  await client.query("delete from public.listing_copies");
  await client.query("delete from public.federation_alerts");
  await client.query("delete from public.federation_partners");
  await client.query("set local session_replication_role = replica");
  await client.query("delete from public.user_roles");
  await client.query("delete from public.role_permissions");
  await client.query("set local session_replication_role = origin");
  await client.query("insert into public.role_permissions (role, permission) values ('editor', 'listings.manage')");
  await client.query("insert into auth.users (id, email) values ($1, 'sa@node.example'), ($2, 'ed@node.example')", [SUPER_ADMIN, EDITOR]);
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'super_admin'), ($2, 'editor')", [SUPER_ADMIN, EDITOR]);
  const insert = `insert into public.federation_partners (domain, node_uuid, node_name, keys_json, trust_level, sync_watermark)
                  values ($1, gen_random_uuid(), $1, '[]', 'verified', '2026-09-01T10:00:00Z') returning id`;
  ending = (await client.query(insert, ["ending.example"])).rows[0].id;
  other = (await client.query(insert, ["other.example"])).rows[0].id;

  await copy(ending, uri("ending.example", 1), { usage: { display: true, expires_with_listing: true } }, { identifiers: ["hin:ABC1"] });
  await copy(ending, uri("ending.example", 2), { usage: { display: true, expires_with_listing: false } });
  await copy(ending, uri("ending.example", 3), { id: "no usage block" });
  await copy(ending, uri("ending.example", 4), null, { tombstoned: true });
  await copy(other, uri("other.example", 5), { usage: { display: true, expires_with_listing: true } }, { identifiers: ["hin:ABC1"] });
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

const state = async () =>
  Object.fromEntries(
    (
      await client.query(
        "select right(canonical_uri, 1) as n, payload is not null as has_data, tombstoned_at, display_state, in_conflict from public.listing_copies order by 1",
      )
    ).rows.map((row) => [row.n, { data: row.has_data, tombstoned: row.tombstoned_at, display: row.display_state, conflict: row.in_conflict }]),
  );

describe("ID-10 ending a partnership", () => {
  it("drops the data of copies whose terms end with it, keeps the rest, and resets the watermark", async () => {
    const [{ end_partnership: ended }] = await asUser(SUPER_ADMIN, "select public.end_partnership($1)", [ending]);
    expect(ended).toBe(2);
    expect(await state()).toEqual({
      // expires_with_listing: true — ended, at the version held.
      "1": { data: false, tombstoned: "2026-09-01T10:00:00Z", display: "held", conflict: false },
      // expires_with_listing: false — the terms allow keeping it.
      "2": { data: true, tombstoned: null, display: "published", conflict: false },
      // No usage block — read as the recommended default, and ended.
      "3": { data: false, tombstoned: "2026-09-01T10:00:00Z", display: "held", conflict: false },
      // Already ended by a tombstone: untouched.
      "4": { data: false, tombstoned: "2026-09-02T10:00:00Z", display: "published", conflict: false },
      // The other partner's copy has lost its only rival (ID-9).
      "5": { data: true, tombstoned: null, display: "published", conflict: false },
    });
    const { rows } = await client.query("select trust_level, sync_watermark from public.federation_partners where id = $1", [ending]);
    expect(rows).toEqual([{ trust_level: "blocked", sync_watermark: null }]);
  });

  it("needs federation.manage", async () => {
    await expect(asUser(EDITOR, "select public.end_partnership($1)", [ending])).rejects.toMatchObject({ code: "42501" });
    expect((await state())["1"]!.data).toBe(true);
  });
});
