-- Consumer role: partners, and the copies of their listings.
--
-- A copy is another node's listing, held here with its provenance. Copies live
-- in their own table and never share one with this node's own listings: that
-- separation is what makes it impossible to serve a copy as ours (ID-4), and
-- hard to edit one by accident (ID-5).

-- ---------------------------------------------------------------------------
-- Policy helper: evaluate once per statement
-- ---------------------------------------------------------------------------
-- A function called bare inside a policy runs for every row. Wrapped in a
-- scalar subquery, Postgres evaluates it once and reuses the result. The
-- policies of the first migration are restated in that form.

alter policy "Users read their own role; admins read every role" on public.user_roles
  using (user_id = (select auth.uid()) or (select private.current_role_rank()) >= 80);

alter policy "Role holders can read the node state" on public.node_settings
  using ((select private.current_role_rank()) > 0);

alter policy "Super admins can read published key metadata" on public.federation_keys
  using ((select private.current_role_rank()) >= 100);

-- ---------------------------------------------------------------------------
-- Partners
-- ---------------------------------------------------------------------------
-- Mirrors the spec's reference record (federation-protocol.md §Partner record)
-- and adds the consumer's sync state and the per-partner acceptance policy.

create table public.federation_partners (
  id                   bigint generated always as identity primary key,
  -- The partner's identity domain. Trust hangs off this and nothing else.
  domain               text not null unique check (domain = lower(domain) and domain <> ''),
  -- Not a trust anchor: it exists to notice that a domain now hosts a
  -- different installation (FP-11).
  node_uuid            uuid not null,
  node_name            text not null,
  -- Keys cached from the partner's discovery document.
  keys_json            jsonb not null,
  keys_fetched_at      timestamptz not null default now(),
  -- Out-of-band pin (FP-12). While set, no other key is accepted until an
  -- administrator confirms it, whatever the discovery document serves.
  pinned_key_id        text check (pinned_key_id ~ '^[0-9a-f]{16}$'),
  trust_level          text not null check (trust_level in ('verified', 'provisional', 'blocked')),
  approved_by          uuid references auth.users (id) on delete set null,
  -- Syncing is not publishing. The policy decides what happens to a partner's
  -- listings once stored, and it belongs to the partner, never to a listing.
  acceptance_policy    text not null default 'hold' check (acceptance_policy in ('accept_all', 'accept_matching', 'hold')),
  -- `updated_since` for the next poll: the newest `updated_at` received, kept
  -- as the authority wrote it and sent back verbatim. Null means a cold sync.
  sync_watermark       text,
  last_ok_at           timestamptz,
  last_attempt_at      timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  -- The partner answered PARTNER_PROVISIONAL: reachable, waiting on a human
  -- there. Deliberately not a failure.
  awaiting_approval    boolean not null default false,
  request_sent_at      timestamptz,
  created_at           timestamptz not null default now()
);

create index federation_partners_approved_by_idx on public.federation_partners (approved_by);

alter table public.federation_partners enable row level security;

-- Partners are federation configuration: the super_admin's alone.
create policy "Super admins manage partners"
  on public.federation_partners for all to authenticated
  using ((select private.current_role_rank()) >= 100)
  with check ((select private.current_role_rank()) >= 100);

-- ---------------------------------------------------------------------------
-- Listing copies
-- ---------------------------------------------------------------------------

create table public.listing_copies (
  -- The canonical URI is the identifier: stored and compared as an opaque
  -- string (ID-2), and unique by construction.
  canonical_uri      text primary key check (canonical_uri like 'https://%'),
  -- RESTRICT, not CASCADE: the partner row is the provenance anchor of every
  -- copy (ID-3). A partner that has delivered listings is blocked, not deleted.
  partner_id         bigint not null references public.federation_partners (id) on delete restrict,
  listing_type       text not null check (listing_type in ('sale', 'charter')),
  status             text not null check (status in ('active', 'under_offer', 'sold', 'withdrawn')),
  -- The authority's `updated_at`, verbatim. Text on purpose: it is compared for
  -- equality with what the authority sends next, and a tombstone's timestamp
  -- can legitimately be newer than the re-shared listing that follows it.
  listing_updated_at text not null,
  -- As received, with descriptions sanitised on receipt (LS-5). Null once the
  -- listing has ended: all use of the data ceases (ID-7, ID-10).
  payload            jsonb,
  -- The mandatory provenance block (ID-3).
  provenance         jsonb not null,
  tombstoned_at      text,
  display_state      text not null default 'held' check (display_state in ('published', 'held')),
  held_reasons       text[] not null default '{}',
  -- HIN / IMO, normalised, for hard-identifier conflict detection (ID-9).
  hard_identifiers   text[] not null default '{}',
  in_conflict        boolean not null default false,
  -- Builder or category slugs missing from the vendored registries (LS-12).
  unknown_slugs      text[] not null default '{}',
  first_received_at  timestamptz not null default now(),
  last_received_at   timestamptz not null default now(),
  constraint listing_copies_ended_has_no_payload check (tombstoned_at is null or payload is null)
);

create index listing_copies_partner_id_idx on public.listing_copies (partner_id);

-- Conflict detection asks "which live copies share any of these identifiers?"
-- — an array overlap, which is what GIN answers. Partial: ended listings never
-- take part.
create index listing_copies_live_identifiers_idx on public.listing_copies using gin (hard_identifiers)
  where tombstoned_at is null;

alter table public.listing_copies enable row level security;

create policy "Role holders can read listing copies"
  on public.listing_copies for select to authenticated
  using ((select private.current_role_rank()) > 0);

-- No write policy: copies are written by the sync engine (service role) only.
-- Nobody edits a copy (ID-5).

-- ---------------------------------------------------------------------------
-- Privileges — stated, not inherited from the project's settings
-- ---------------------------------------------------------------------------
revoke all on public.federation_partners, public.listing_copies from anon, authenticated;
grant select, insert, update, delete on public.federation_partners to authenticated;
grant select on public.listing_copies to authenticated;
grant all on public.federation_partners, public.listing_copies to service_role;
