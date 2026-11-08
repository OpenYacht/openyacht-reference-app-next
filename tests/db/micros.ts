import type pg from "pg";

/**
 * Runs a query that selects one timestamptz column and returns its first value
 * as whole microseconds since the epoch.
 *
 * Postgres keeps microseconds; a JavaScript Date keeps milliseconds. Two writes
 * inside the same millisecond compare equal as Dates, so an assertion that a
 * timestamp moved has to compare at the database's own precision.
 */
export async function micros(client: pg.Client, query: string, values: unknown[] = []): Promise<bigint> {
  const { rows } = await client.query<{ us: string }>(`select (extract(epoch from t.v) * 1000000)::bigint as us from (${query}) as t(v)`, values);
  if (rows.length === 0) throw new Error(`No row for: ${query}`);
  return BigInt(rows[0]!.us);
}
