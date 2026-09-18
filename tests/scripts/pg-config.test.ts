// Connection rules for the migration runner and the database lane.
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { explainConnectionError, pgConfig } from "../../scripts/lib/pg-config.mjs";

const root = process.cwd();
const POOLER = "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres";

describe("database connection settings", () => {
  it("returns null when no database URL is configured — blank counts as missing", () => {
    expect(pgConfig({}, root)).toBeNull();
    expect(pgConfig({ POSTGRES_URL_NON_POOLING: "  ", DATABASE_URL: "" }, root)).toBeNull();
  });

  it("prefers POSTGRES_URL_NON_POOLING over DATABASE_URL", () => {
    const config = pgConfig({ POSTGRES_URL_NON_POOLING: POOLER, DATABASE_URL: "postgresql://postgres@localhost/other" }, root);
    expect(config?.connectionString).toContain("pooler.supabase.com");
  });

  it("uses no TLS for a local database", () => {
    expect(pgConfig({ DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }, root)).toEqual({
      connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
  });

  it("always verifies the certificate of a remote database, and sslmode in the URL cannot switch that off", () => {
    for (const mode of ["disable", "no-verify", "require", "prefer"]) {
      const config = pgConfig({ DATABASE_URL: `postgresql://user:pw@db.example.com:5432/app?sslmode=${mode}` }, root);
      expect(config?.ssl).toEqual({ rejectUnauthorized: true });
      expect(config?.connectionString).not.toContain("sslmode");
    }
  });

  it.each([POOLER, "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"])(
    "trusts the bundled Supabase root CA for a Supabase host with nothing configured",
    (url) => {
      const config = pgConfig({ POSTGRES_URL_NON_POOLING: url }, root);
      const ssl = config?.ssl as { rejectUnauthorized: boolean; ca: string };
      expect(ssl.rejectUnauthorized).toBe(true);
      const certificate = new X509Certificate(ssl.ca);
      expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
      expect(certificate.ca).toBe(true);
      // Fails a year ahead of expiry, while replacing the file is still routine.
      expect(new Date(certificate.validTo).getTime() - Date.now()).toBeGreaterThan(365 * 24 * 3600 * 1000);
    },
  );

  it("lets DATABASE_SSL_CA override the bundled root, as PEM text", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(pgConfig({ POSTGRES_URL_NON_POOLING: POOLER, DATABASE_SSL_CA: pem }, root)?.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
  });
});

describe("connection errors explain themselves", () => {
  it("names the CA setting for a certificate failure", () => {
    expect(explainConnectionError(new Error("self-signed certificate in certificate chain"))).toContain("DATABASE_SSL_CA");
  });

  it("names the Session pooler for Supabase's IPv6-only direct host", () => {
    expect(explainConnectionError(new Error("getaddrinfo ENOENT db.abc.supabase.co"))).toContain("Session pooler");
  });
});
