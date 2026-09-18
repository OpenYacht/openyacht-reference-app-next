@AGENTS.md

# OpenYacht reference node — Next.js + Supabase

A complete, conventional, working OpenYacht node, written to be read: a developer (or a coding agent) should be able to lift patterns from it.
Reference material first. Boring, idiomatic code — no ORM over Supabase, no state library, no bespoke abstraction where the framework has a
convention.

## The spec is the source

The normative protocol lives in the public [`OpenYacht/protocol`](https://github.com/OpenYacht/protocol) repository. Read
`spec/conformance-checklist.md` first; the four spec documents win over everything else, including this file.

- This implementation is written **from the spec**. Where the spec is unclear, make the narrowest reasonable choice, say so in a comment at the
  point of implementation, and raise the ambiguity with the protocol repository.
- **Types come from the schemas, never from memory.** `protocol/` is vendored by `pnpm vendor:protocol`; `federation/generated/` is generated
  from it by `pnpm generate:types`. Both are committed; CI fails if the generated types drift. Never hand-edit either directory.
- Every emitted payload is validated against the vendored schemas with Ajv (2020-12, strict) in tests.
- Registries and schemas are read from disk. Nothing under `protocol/` is ever fetched at request time (LS-13).

## The one structural rule: `federation/` is framework-free

`federation/` imports `node:` built-ins and its own files — nothing else. No Next.js, no React, no Supabase, no `pg`, no `@/lib`. Storage,
outbound HTTP and time reach it through the interfaces in `federation/ports.ts`. The directory must lift unchanged into Express, Fastify, Hono
or Nest; Next and Supabase are the demonstration harness around it. ESLint enforces this (`no-restricted-imports`). Do not trade it away.

- `federation/` — the core: signing, verification, keys, discovery, the outbound guard and HTTPS client, partner operations, the sync engine,
  copies, staleness.
- `lib/federation/handlers.ts` — `Request → Response` handlers with injected dependencies (unit-testable without Next or a database).
- `app/.well-known/`, `app/openyacht/v1/` — three-line route files binding handlers to the real store. Node runtime, never Edge.
- `lib/federation/repositories.ts` implements the core's repositories over Supabase and takes the client to use: an administrator's action passes
  the signed-in user's client (RLS decides), the sync engine passes the service-role client. `lib/federation/consumer.ts` wires it together.
- `lib/supabase/service.ts` (service role, bypasses RLS: federation + setup only) and `lib/supabase/server.ts` (the signed-in user, under RLS)
  are two trust domains. A federation partner is authenticated by signature, never by a Supabase JWT. Do not mix them.

## Conventions

- **Conformance IDs name the tests**: `describe("FP-7 signing string")`. The public checklist maps 1:1 onto the suite. Put spec
  cross-references in comments at the point of implementation.
- **Blank is missing.** Read environment variables through `lib/env.ts`; identity values through `parseNodeIdentity`. A blank required value
  fails loudly — it is never published as an empty string.
- **HeroUI v3 composition**: in Server Components use the named part exports (`CardHeader`), never dot-notation (`Card.Header`). For `Radio` and
  `Checkbox` the control goes _inside_ the content row beside the label — `<RadioContent><RadioControl><RadioIndicator /></RadioControl><Label/></RadioContent>` —
  with `Description` as a sibling below. Each component's anatomy is documented at the top of its stylesheet in `@heroui/styles/dist/components/`.
  A build proves HeroUI compiles, not that a form is laid out correctly: look at new UI in a browser.
- **Outbound requests to partner-supplied hosts go through `GuardedHttpsClient` only** — never `fetch`. The guard runs inside the socket's DNS
  lookup, so the address checked is the address dialled; redirects are not followed.
- **Copies are never edited and never relayed.** `listing_copies` has no write policy for signed-in users; only the sync engine writes it. The
  sanitiser runs on receipt and again at render.
- **No development escape hatch in security checks** — the outbound guard, the host guard and TLS verification have no dev-mode bypass.
- **Migrations state their own privileges.** Hand-written SQL in `supabase/migrations/`, named `<14-digit timestamp>_<snake_case>.sql`. Every
  table enables RLS and is followed by explicit `revoke`/`grant` statements — never rely on a project's "expose new tables" setting.
  `pnpm migrate` (no CLI, no Docker) and `supabase db push` share one ledger. A migration that changes what a listing serves on the wire MUST
  stamp the wire `updated_at` of the affected listings, after any backfill — otherwise `updated_since` consumers never see the change.
- **Database connections** go through `scripts/lib/pg-config.mjs`: verified TLS for every remote host, no opt-out.
- A green suite is not an install test. Anything touching setup, migrations or `.env.example` gets checked from a fresh clone against an empty
  database.

## What goes in a commit

This repository is reference material and is read as such. Commits, comments and documentation describe **this codebase and the protocol** —
nothing else.

- No working notes, plans, milestone labels, session logs or to-do lists. No references to other codebases, to private documents, or to any
  particular machine or person. Keep those outside the repository (`CLAUDE.local.md` and `notes/` are gitignored for the purpose).
- No company names, no provenance claims, nothing about listing-feed or MLS providers.
- Fictional inventory only: registry builders, invented vessels, `*.example` domains, 555 phone numbers.
- Copyright line: "The OpenYacht contributors" — never a personal name.
- Commit messages say what changed and why, in the imperative, in terms of this repository alone.

## Versions

Latest stable everything, resolved with `pnpm view <pkg> version` — never from memory. Two deliberate exceptions, to revisit whenever
dependencies are bumped:

- **TypeScript 6.0.x, not 7**: `typescript-eslint` (pulled in by `eslint-config-next`) declares `typescript <6.1.0`.
- **ESLint 9.x, not 10**: `eslint-plugin-import`, `eslint-plugin-react` and `eslint-plugin-jsx-a11y` (all inside `eslint-config-next`) declare
  `eslint ^9` at most.

`@types/node` tracks the Node major in use, not the newest published. pnpm stays on 10.x: launchers are backward- but not forward-compatible,
so pin low. pnpm 10 blocks dependency build scripts; the allow-list is `onlyBuiltDependencies` in `pnpm-workspace.yaml` and is committed on
purpose.

## Commands

```bash
pnpm test           # unit lane: federation core + handlers. No database, no network.
pnpm test:db        # database lane: needs POSTGRES_URL_NON_POOLING; every test rolls back
pnpm typecheck
pnpm lint
pnpm format
pnpm build
pnpm migrate
pnpm vendor:protocol   # re-vendor ./protocol and regenerate the types
```

- Do not start `pnpm dev` in the foreground from an agent session — it never returns. Verify through `pnpm build`, the test lanes, and requests
  against a server the developer has running.
- Federation routes answer only on `OPENYACHT_DOMAIN`. To reach them on a local server:
  `curl --connect-to <domain>:80:127.0.0.1:3000 http://<domain>/.well-known/openyacht`.
- Commit coherent units of work as you go, each passing the gate. Never push: publishing is the maintainer's step.
