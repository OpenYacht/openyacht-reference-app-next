// Database lane: a listing's media block and the files behind it. Needs a
// Supabase database — the storage schema is part of what is tested. Every test
// rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConfig } from "../../scripts/lib/pg-config.mjs";

const config = pgConfig(process.env, process.cwd());
if (config === null) throw new Error("The database lane needs POSTGRES_URL_NON_POOLING or DATABASE_URL.");

const EDITOR = "00000000-0000-4000-8000-0000000000d1";
const BROKER = "00000000-0000-4000-8000-0000000000d2";
const OTHER_BROKER = "00000000-0000-4000-8000-0000000000d3";
const VIEWER = "00000000-0000-4000-8000-0000000000d4";

const client = new pg.Client(config);
let listing: { id: string; uuid: string };

beforeAll(() => client.connect());
afterAll(() => client.end());

beforeEach(async () => {
  await client.query("begin");
  await client.query(
    "insert into auth.users (id, email) values ($1, 'e@node.example'), ($2, 'b@node.example'), ($3, 'o@node.example'), ($4, 'v@node.example')",
    [EDITOR, BROKER, OTHER_BROKER, VIEWER],
  );
  await client.query("insert into public.user_roles (user_id, role) values ($1, 'editor'), ($2, 'broker'), ($3, 'broker'), ($4, 'viewer')", [
    EDITOR,
    BROKER,
    OTHER_BROKER,
    VIEWER,
  ]);
  const vesselId = (await client.query("insert into public.vessels (builder_name) values ('Maritimo') returning id")).rows[0].id;
  listing = (
    await client.query(
      "insert into public.listings (vessel_id, listing_type, name, status, assigned_broker_id) values ($1, 'sale', 'TEST PATTERN', 'active', $2) returning id, uuid",
      [vesselId, BROKER],
    )
  ).rows[0];
});
afterEach(() => client.query("rollback"));

/** Runs one statement as a signed-in user and keeps what it wrote. */
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

const image = (id: string) => ({ id, path: `${listing.uuid}/${id}/derived.jpg`, thumbnail_path: `${listing.uuid}/${id}/thumbnail.jpg` });
const add = (userId: string, collection: string, item: object) =>
  asUser<{ replaced: { id: string } | null }>(userId, "select public.add_listing_media($1, $2, $3) as replaced", [
    listing.id,
    collection,
    JSON.stringify(item),
  ]).then((rows) => rows[0]!.replaced);
const remove = (userId: string, collection: string, id: string) =>
  asUser<{ removed: { id: string } | null }>(userId, "select public.remove_listing_media($1, $2, $3) as removed", [listing.id, collection, id]).then(
    (rows) => rows[0]!.removed,
  );
const media = () => client.query("select media, federation_updated_at from public.listings where id = $1", [listing.id]).then((r) => r.rows[0]!);
const gallery = async () => ((await media()).media.gallery as { id: string; sort: number }[]).map((item) => [item.id, item.sort]);

describe("LS-8 a listing with any imagery has a profile image", () => {
  it("refuses a gallery or layout image until there is a profile image", async () => {
    await expect(add(BROKER, "gallery", image("a"))).rejects.toThrow(/LS-8/);
    await expect(add(BROKER, "layouts", image("a"))).rejects.toThrow(/LS-8/);
    await add(BROKER, "profile", image("hero"));
    await add(BROKER, "gallery", image("a"));
    expect(await gallery()).toEqual([["a", 1]]);
  });

  it("will not remove the profile image from under a gallery — only replace it", async () => {
    await add(BROKER, "profile", image("hero"));
    await add(BROKER, "gallery", image("a"));
    await expect(remove(BROKER, "profile", "hero")).rejects.toThrow(/LS-8/);

    // Replacing hands the old one back, so that its files can be removed.
    expect((await add(BROKER, "profile", image("hero-2")))?.id).toBe("hero");
    expect((await media()).media.profile.id).toBe("hero-2");

    await remove(BROKER, "gallery", "a");
    expect((await remove(BROKER, "profile", "hero-2"))?.id).toBe("hero-2");
    expect((await media()).media.profile).toBeNull();
  });

  it("a video link needs no imagery at all", async () => {
    await add(BROKER, "videos", { id: "v", url: "https://video.example/watch/1" });
    expect((await media()).media.videos).toEqual([{ id: "v", url: "https://video.example/watch/1", sort: 1 }]);
  });
});

describe("changing the media block", () => {
  beforeEach(async () => {
    await add(BROKER, "profile", image("hero"));
    for (const id of ["a", "b", "c"]) await add(BROKER, "gallery", image(id));
  });

  it("appends in order", async () => {
    expect(await gallery()).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("moves an item by exchanging places with its neighbour, and stops at either end", async () => {
    const move = (id: string, direction: number) =>
      asUser(BROKER, "select public.move_listing_media($1, 'gallery', $2, $3)", [listing.id, id, direction]);
    await move("c", -1);
    expect((await gallery()).map(([id]) => id)).toEqual(["a", "c", "b"]);
    await move("a", -1);
    await move("b", 1);
    expect((await gallery()).map(([id]) => id)).toEqual(["a", "c", "b"]);
  });

  it("removing hands the item back and renumbers nothing it does not have to", async () => {
    expect((await remove(BROKER, "gallery", "b"))?.id).toBe("b");
    expect(await remove(BROKER, "gallery", "b")).toBeNull();
    expect((await gallery()).map(([id]) => id)).toEqual(["a", "c"]);
    // The next item still sorts after everything present.
    await add(BROKER, "gallery", image("d"));
    expect((await gallery()).at(-1)).toEqual(["d", 4]);
  });

  it("sets a caption and a category, and refuses a category outside the schema's list", async () => {
    const describeItem = (caption: string | null, category: string | null) =>
      asUser(BROKER, "select public.describe_listing_media($1, 'gallery', 'a', $2, $3)", [listing.id, caption, category]);
    await describeItem("  Aft deck at anchor ", "exterior");
    expect((await media()).media.gallery[0]).toMatchObject({ id: "a", caption: "Aft deck at anchor", category: "exterior" });
    await describeItem("", null);
    expect((await media()).media.gallery[0]).toMatchObject({ caption: null, category: null });
    await expect(describeItem(null, "aerial")).rejects.toThrow(/category/);
  });

  it("every change moves the wire updated_at, so partners receive it", async () => {
    const before = (await media()).federation_updated_at as Date;
    await asUser(BROKER, "select public.describe_listing_media($1, 'gallery', 'a', 'Bow', null)", [listing.id]);
    expect(((await media()).federation_updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it("refuses an unknown collection", async () => {
    await expect(add(BROKER, "posters", image("x"))).rejects.toThrow(/Unknown media collection/);
  });
});

describe("whose listing it is", () => {
  it("an editor changes any listing's media; a broker only their own; a viewer none", async () => {
    await add(EDITOR, "profile", image("hero"));
    for (const userId of [OTHER_BROKER, VIEWER]) {
      await expect(add(userId, "gallery", image("x"))).rejects.toThrow(/not yours to change/);
      await expect(remove(userId, "profile", "hero")).rejects.toThrow(/not yours to change/);
    }
    expect((await media()).media.profile.id).toBe("hero");
  });

  it("nobody who is not signed in can call these at all", async () => {
    await client.query("savepoint anon");
    await client.query("set local role anon");
    await expect(client.query("select public.add_listing_media($1, 'profile', '{\"id\":\"x\"}')", [listing.id])).rejects.toThrow(/permission denied/);
    await client.query("rollback to savepoint anon");
  });
});

describe("the files behind the media block", () => {
  const put = (userId: string, bucket: string, name: string) =>
    asUser(userId, "insert into storage.objects (bucket_id, name) values ($1, $2) returning id", [bucket, name]);

  it("the buckets exist: one public, originals and uploads private, all size-limited", async () => {
    const { rows } = await client.query("select id, public, file_size_limit from storage.buckets where id like 'listing-%' order by id");
    expect(rows).toEqual([
      { id: "listing-media", public: true, file_size_limit: "26214400" },
      { id: "listing-originals", public: false, file_size_limit: "26214400" },
      { id: "listing-uploads", public: false, file_size_limit: "26214400" },
    ]);
  });

  it("whoever may change the listing may write under its UUID, in these buckets only", async () => {
    await put(BROKER, "listing-uploads", `${listing.uuid}/a/upload`);
    await put(EDITOR, "listing-media", `${listing.uuid}/a/derived.jpg`);
    await put(BROKER, "listing-originals", `${listing.uuid}/a/original.jpg`);
  });

  it.each([
    ["another broker", OTHER_BROKER],
    ["a viewer", VIEWER],
  ])("%s may not", async (_label, userId) => {
    await expect(put(userId, "listing-media", `${listing.uuid}/a/derived.jpg`)).rejects.toThrow(/row-level security/);
  });

  it.each([
    ["a listing that does not exist", "00000000-0000-4000-8000-00000000ffff/a/derived.jpg"],
    ["a name that is not under a listing", "loose.jpg"],
    ["a name that only resembles a UUID", "not-a-uuid/a/derived.jpg"],
  ])("refuses %s, without an error from the cast", async (_label, name) => {
    await expect(put(EDITOR, "listing-media", name)).rejects.toThrow(/row-level security/);
  });

  it("an editor can clear away the files of a listing that no longer exists; a broker cannot see them", async () => {
    await client.query(
      "insert into storage.objects (bucket_id, name) values ('listing-media', '00000000-0000-4000-8000-00000000ffff/a/derived.jpg')",
    );
    const visible = (userId: string) =>
      asUser<{ n: string }>(userId, "select count(*) as n from storage.objects where name like '00000000-0000-4000-8000-00000000ffff/%'").then(
        (rows) => Number(rows[0]!.n),
      );
    expect(await visible(EDITOR)).toBe(1);
    expect(await visible(BROKER)).toBe(0);
  });

  it("sees only the files of listings that are theirs to change", async () => {
    await put(BROKER, "listing-originals", `${listing.uuid}/a/original.jpg`);
    const count = (userId: string) =>
      asUser<{ n: string }>(userId, "select count(*) as n from storage.objects where bucket_id = 'listing-originals'").then((rows) =>
        Number(rows[0]!.n),
      );
    expect(await count(OTHER_BROKER)).toBe(0);
    expect(await count(VIEWER)).toBe(0);
    expect(await count(BROKER)).toBe(1);
  });
});
