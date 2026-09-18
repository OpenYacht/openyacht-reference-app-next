// Applies supabase/migrations/*.sql over a direct Postgres connection.
//
// This is the install path: it needs no Supabase CLI and no Docker, so it can
// run inside `pnpm build` on any host. It records applied files in
// supabase_migrations.schema_migrations — the table `supabase db push` itself
// uses — so the CLI and this runner share one ledger and neither re-applies
// what the other has run.
//
//   pnpm migrate                   apply pending migrations; fail without a database URL
//   pnpm migrate -- --if-configured   the form `pnpm build` uses: skip, loudly, when no URL is set
//   pnpm migrate -- --status          list applied and pending files, change nothing
//
// Connection string: POSTGRES_URL_NON_POOLING, then DATABASE_URL. It must be a
// session-level connection — Supabase's direct connection or its Session
// pooler (port 5432) — because migrations hold an advisory lock for the
// session, which the Transaction pooler (port 6543) cannot do. Remote hosts are
// always reached over verified TLS; see scripts/lib/pg-config.mjs.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { explainConnectionError, pgConfig } from "./lib/pg-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase/migrations");
const FILE_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 8_015_321_774; // arbitrary, constant: one migration run per database at a time

const ifConfigured = process.argv.includes("--if-configured");
const statusOnly = process.argv.includes("--status");

loadEnvFile(".env.local");
loadEnvFile(".env");

const config = pgConfig(process.env, root);
if (config === null) {
  const message = "No database URL: set POSTGRES_URL_NON_POOLING (or DATABASE_URL) to a direct Postgres connection string.";
  if (ifConfigured) {
    console.warn(`migrate: SKIPPED — ${message}`);
    process.exit(0);
  }
  console.error(`migrate: ${message}`);
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const name of files) {
  if (!FILE_PATTERN.test(name)) {
    console.error(`migrate: "${name}" is not named <14-digit timestamp>_<snake_case_name>.sql`);
    process.exit(1);
  }
}

const client = new pg.Client(config);

try {
  await client.connect();
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  await client.query("create schema if not exists supabase_migrations");
  await client.query(
    "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)",
  );
  const applied = new Set((await client.query("select version from supabase_migrations.schema_migrations")).rows.map((row) => row.version));
  const pending = files.filter((name) => !applied.has(FILE_PATTERN.exec(name)[1]));

  if (statusOnly) {
    for (const name of files) console.log(`${pending.includes(name) ? "pending" : "applied"}  ${name}`);
  } else if (pending.length === 0) {
    console.log(`migrate: up to date (${files.length} applied)`);
  } else {
    for (const name of pending) {
      const [, version, label] = FILE_PATTERN.exec(name);
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      // One transaction per file: a migration applies completely or not at all.
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)", [
          version,
          [sql],
          label,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`${name} failed and was rolled back: ${error.message}`, { cause: error });
      }
      console.log(`migrate: applied ${name}`);
    }
  }
} catch (error) {
  console.error(`migrate: ${explainConnectionError(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

// A minimal KEY=VALUE reader so the script has no dependency on Next.js.
// Variables already present in the environment win.
function loadEnvFile(name) {
  let text;
  try {
    text = readFileSync(join(root, name), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
