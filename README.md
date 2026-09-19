# OpenYacht reference node — Next.js + Supabase

A working [OpenYacht](https://github.com/OpenYacht/protocol) federation node, built with Next.js (App Router), TypeScript and Supabase, and
written to be read. OpenYacht is server-to-server sharing of yacht listings between brokerages with no central operator: each node is
identified by its domain, publishes its keys at a well-known URL, and signs every federation request.

This is **reference material first**. It is a complete node you can run, but its main job is to show — to a developer, or to a coding agent
pointed at it — how each requirement of the specification looks in ordinary TypeScript. The test suite is organised by the spec's
[conformance checklist](https://github.com/OpenYacht/protocol/blob/main/spec/conformance-checklist.md): `describe("FP-7 …")` is requirement
FP-7.

> **Status: in progress.** Built so far: the federation core (keys, signing, verification, discovery) and first-run setup; the **consumer
> role** — adding partners, the signed partnership request, cold sync and `updated_since` polling, tombstones, copies with provenance, a
> per-partner acceptance policy, and receiving signed partnership requests from nodes that contact this one first; the **authority role** —
> this node's own sale and charter listings, per-listing sharing, per-partner field groups, the partner feed with tombstones and an opaque
> cursor, and listing media (renditions and SHA-256 hashes made at upload, originals behind expiring URLs); **key rotation**, routine with
> a 48-hour overlap and emergency without one; and **rate limiting**, per partner on the signed endpoints and per client address on the
> discovery document. Push subscriptions are not implemented, and `capabilities` says so.

## The part you can lift: `federation/`

`federation/` is **framework-free TypeScript**. It imports Node's built-ins and nothing else — no Next.js, no Supabase, no HTTP or database
client, and no third-party cryptography (Ed25519 is `node:crypto`). Storage, outbound HTTP and the clock reach it through the small interfaces
in [`federation/ports.ts`](federation/ports.ts). Copy the directory into an Express, Fastify, Hono or Nest application and implement those
interfaces; Next.js and Supabase are only the harness demonstrated around it.

| File                                   | What it implements                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `signing-string.ts`                    | The five-field signing string (FP-7)                                                                                   |
| `keys.ts`                              | Ed25519 keypairs, key-ID derivation, strict public-key decoding (FP-3)                                                 |
| `signer.ts`                            | The four `X-OpenYacht-*` headers for an outbound request (FP-6)                                                        |
| `verifier.ts`                          | The spec's six-step verification procedure: window, blocked, keys, refetch-and-retry, UUID change, pins (FP-8 – FP-12) |
| `well-known.ts`                        | Building this node's discovery document; strictly parsing a partner's (FP-1, FP-5)                                     |
| `well-known-client.ts`                 | Fetching a partner's discovery document, rate-limited (FP-2, FP-10)                                                    |
| `outbound-guard.ts`, `https-client.ts` | Every outbound request: public hosts only, checked at connection time; verified TLS; no redirects (FP-2, FP-14)        |
| `signed-client.ts`                     | Signed requests to a partner                                                                                           |
| `partners.ts`                          | Adding a partner, key refresh and pin confirmation, the partnership request, removal (FP-11 – FP-13, FP-16)            |
| `sync.ts`, `feed.ts`                   | Cold sync and `updated_since` polling, tombstones, pagination (API-2, API-3, API-7, API-8, ID-7)                       |
| `copies.ts`                            | Sanitising on receipt, the acceptance policy, vessel-identity conflicts, registry slugs (ID-3 – ID-10, LS-5, LS-12)    |
| `staleness.ts`                         | The 7-day stale flag, the 30-day hide, and polling backoff (FP-15)                                                     |
| `documents.ts`                         | `capabilities` and `health` (API-6)                                                                                    |
| `errors.ts`                            | The error envelope and its HTTP status mapping (API-9)                                                                 |
| `identity.ts`                          | Identity configuration that fails loudly, and the single-host guard                                                    |
| `generated/`                           | Wire types generated from the protocol's JSON Schemas — never written by hand                                          |

The protocol's schemas, registries, OpenAPI document and test vectors are vendored under [`protocol/`](protocol/) (`pnpm vendor:protocol`) and
read from disk. Nothing is fetched from a third party when validating or serving a listing.

## Requirements

- Node.js 22.12 or newer, and [pnpm](https://pnpm.io) 10
- A [Supabase](https://supabase.com) project — a free hosted project is enough. **Docker is not required.**

One Supabase project is one node. There is no multi-tenancy.

## Getting started

```bash
git clone https://github.com/OpenYacht/openyacht-reference-app-next.git
cd openyacht-reference-app-next
pnpm install
cp .env.example .env.local
```

Fill in `.env.local` — every variable is explained in [`.env.example`](.env.example). You need the node's identity, a `SETUP_TOKEN` of your
choosing, and four values from the Supabase dashboard:

| Value                       | Where it is                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Project URL                 | The **Connect** button in the project's top bar — or `https://<ref>.supabase.co`, where `<ref>` is in the dashboard's address bar |
| Publishable and secret keys | Project Settings → API Keys                                                                                                       |
| Postgres connection string  | **Connect** → Connection string → **Session pooler** (port 5432); put your database password into it                              |

Take the **Session pooler** string unless you know your network has IPv6: the "Direct connection" host is IPv6-only and simply does not
resolve on an IPv4-only network. Never use the Transaction pooler (port 6543) — migrations hold a session-level lock. When creating the
project, keep **Enable Data API** on; **Automatically expose new tables** can be off, as Supabase recommends — the migrations grant exactly
the privileges the app needs.

Database connections are always made over TLS with the certificate verified. Supabase signs its database certificates with its own root CA,
which Node does not trust out of the box, so that root is bundled (`supabase/prod-ca-2021.crt`) and used automatically.

In the Supabase dashboard, switch off **Allow new users to sign up** (Authentication → Sign In / Providers). A node's accounts are created by
the setup wizard and by administrators, never by self-registration.

```bash
pnpm migrate   # applies supabase/migrations/*.sql — no Supabase CLI, no Docker
pnpm dev
```

Open <http://localhost:3000>. Until setup is complete every page leads to `/setup`, which lists anything still missing from the configuration.
The wizard asks for the setup token, creates the first administrator, generates the node UUID and the first Ed25519 signing key (its private
half goes straight into Supabase Vault), and then sends you to the sign-in page.

### The identity domain is permanent

`OPENYACHT_DOMAIN` is the node's identity. It is part of every listing's canonical URI, and partners store those URIs for good — so **there is
no rename**. Choose a hostname under the domain partners already know the business by; a dedicated subdomain (`openyacht.your-brokerage.com`) is
the recommended pattern. If the variable changes after setup, the node disables its federation endpoints rather than fork its identity.

Platform-issued hostnames (`*.vercel.app`, tunnel hostnames and the like) work and are a trap: they are not yours to keep. The wizard only
lets such a domain be set up as a disposable trial node.

A development node's identity is disposable too. Partner it only with nodes whose operators can purge what they synced from you.

### Reaching the federation endpoints locally

Federation endpoints answer **only on the identity domain** and return `404` on every other host, so a node reachable under several names
cannot fork its identity. The admin UI is not restricted, which is why it works on `localhost`. To call the endpoints on a local server,
send the identity domain as the host:

```bash
curl --connect-to node.example:80:127.0.0.1:3000 http://node.example/.well-known/openyacht
```

Federating with another node needs more than that: a partner verifies your requests by fetching _your_ well-known document over public HTTPS,
and every conforming node refuses private, loopback and unresolvable hosts. A development node that federates needs a public hostname — a
tunnel to your local server is the usual answer.

### Things that look like bugs and are not

- **Free Supabase projects pause after about a week idle.** Resume the project from the dashboard.
- **`pnpm migrate` fails with `getaddrinfo ENOTFOUND db.….supabase.co`.** That is the IPv6-only direct host; use the Session pooler string.
- **`/.well-known/openyacht` returns 404 on localhost.** That is the single-host guard; see above.
- **Federation endpoints return 503.** Setup has not been completed, or the database cannot be reached — the server log says which.

## Partners and synchronisation

A super admin adds a partner under **Partners** with nothing but its identity domain. The node fetches the partner's discovery document over
verified TLS, trusts it on first use, and sends a signed partnership request carrying your message — so the other administrator learns who is
asking before approving. Until they approve, their node answers `PARTNER_PROVISIONAL`; that is not an error, and polling simply continues.

**Synchronising is not publishing.** Every listing a partner shares is stored as a copy, with its provenance, and kept current — including
withdrawals, which drop the stored data. Whether a copy is _displayed_ is a per-partner policy: hold everything, accept what arrives complete,
or accept everything. Three things no policy overrides: a listing whose usage terms forbid display, a vessel that two authorities both claim
(both copies are kept and flagged for a person), and a partner that has been unreachable for 30 days.

Next.js has no scheduler, so sync runs when something calls `POST /api/internal/sync` with `INTERNAL_API_SECRET`:

```bash
pnpm sync              # one pass over the partners that are due — the server must be running
pnpm sync -- --force   # ignore the failure backoff
```

In production, point any timer at that route — `pg_cron` with `pg_net` inside the Supabase project, a host's cron feature, or crontab with
`curl`. Hourly is ample; the protocol's obligation is that withdrawals are applied within 24 hours.

Every outbound request goes through a guard that refuses private, loopback and unresolvable hosts, with no development bypass. A partner must
therefore be a real, publicly reachable node — and so must this one, since the partner verifies your requests by fetching _your_ discovery
document.

## Tests

```bash
pnpm test      # unit lane: the federation core, route handlers and the sanitiser. No database, no network.
pnpm test:db   # database lane: RLS policies, the setup function, the Vault round-trip.
```

The database lane runs against `POSTGRES_URL_NON_POOLING`. Every test runs inside a transaction that is rolled back, so it is safe to point at
your development project. CI runs it against a clean local Supabase stack; if you have Docker, `pnpm exec supabase start` gives you the same
thing locally, but nothing requires it.

Also: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm build`.

## How the pieces fit

- **Two trust domains, kept visibly apart.** Federation route handlers use a server-only service-role client; a partner is authenticated by
  request signature, never by a Supabase session. The admin UI uses the signed-in user's session and lives under row level security — the
  policies in [`supabase/migrations/`](supabase/migrations/) are part of what this repository is for.
- **The private key is encrypted at rest** in Supabase Vault. `federation_keys` holds only the secret's id; the single function that
  decrypts it is executable by the service role alone.
- **Migrations apply themselves at build** when a database URL is present (`pnpm build` runs `pnpm migrate` first), which is what lets a
  hosted deploy install itself. `supabase db push` works over the same files and the same ledger, if you prefer the CLI.
- **Roles**: `super_admin`, `admin`, `editor`, `broker`, `viewer`, seeded by the first migration. At least one `super_admin` always exists —
  the database enforces it.

## Deployment

Not written yet. The app is an ordinary Next.js application — `pnpm build && pnpm start` behind any reverse proxy, with any Supabase project,
hosted or self-hosted — and nothing in it depends on a particular host.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## Licence

Copyright (C) 2026 The OpenYacht contributors.

[AGPL-3.0-only](LICENSE). Run it, study it, lift the patterns — and if you operate a modified version as a network service, share your changes
the same way. The copyleft covers this application, not the protocol: the OpenYacht specification (CC-BY-4.0) and its machine-readable
artifacts (MIT), vendored here under [`protocol/`](protocol/) with their licence texts, can be embedded in any implementation, proprietary
ones included.
