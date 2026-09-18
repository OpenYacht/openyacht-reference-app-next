// Connection settings for a direct Postgres connection, shared by the
// migration runner and the database test lane.
//
// The rule: a remote database is always reached over TLS with the certificate
// verified. There is no switch that turns verification off.
//
// Supabase's database certificates chain to Supabase's own root CA, which is
// not in Node's trust store, so without help every connection fails with
// "self-signed certificate in certificate chain". That root is public and
// shared by all projects; it is vendored at supabase/prod-ca-2021.crt
// ("Supabase Root 2021 CA", valid to 2031-04-26) and used automatically for
// Supabase hosts — which is what lets `pnpm migrate` run inside a hosted build
// with nothing but the injected connection string. DATABASE_SSL_CA overrides
// it, for any other host or a future Supabase root.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SUPABASE_HOST = /\.supabase\.(co|com)$/;
const BUNDLED_SUPABASE_CA = "supabase/prod-ca-2021.crt";

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} root directory that a relative DATABASE_SSL_CA path is resolved against
 * @returns {import("pg").ClientConfig | null} null when no database URL is configured
 */
export function pgConfig(env, root) {
  const connectionString = (env.POSTGRES_URL_NON_POOLING ?? "").trim() || (env.DATABASE_URL ?? "").trim();
  if (connectionString === "") return null;

  const url = new URL(connectionString);
  // pg lets `sslmode` in the string override the `ssl` option, and treats the
  // modes inconsistently across versions. Take it out and decide here.
  url.searchParams.delete("sslmode");

  if (LOCAL_HOSTS.has(url.hostname)) return { connectionString: url.toString() };

  // DATABASE_SSL_CA is either PEM text or the path of a PEM file.
  const setting = (env.DATABASE_SSL_CA ?? "").trim() || (SUPABASE_HOST.test(url.hostname) ? BUNDLED_SUPABASE_CA : "");
  const ca = setting === "" || setting.includes("-----BEGIN") ? setting : readFileSync(isAbsolute(setting) ? setting : join(root, setting), "utf8");
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(ca === "" ? {} : { ca }) } };
}

/** Turns the TLS failure everyone meets first into an instruction. */
export function explainConnectionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/self.signed certificate|unable to (get|verify)|certificate/i.test(message)) {
    return (
      `${message}\n  The database's certificate is not signed by a CA this machine trusts. Set DATABASE_SSL_CA to the path of the\n` +
      "  database's CA certificate. (For Supabase the bundled root is used automatically; if this is a Supabase host, its\n" +
      "  root may have changed — download the current one from Project Settings → Database → SSL Configuration.)"
    );
  }
  if (/ENOTFOUND|ENOENT|ENETUNREACH|EHOSTUNREACH/.test(message)) {
    return (
      `${message}\n  The database host could not be reached. Supabase's direct connection (db.<ref>.supabase.co) is IPv6-only;\n` +
      "  on an IPv4-only network use the Session pooler connection string (port 5432) from the dashboard's Connect dialog."
    );
  }
  return message;
}
