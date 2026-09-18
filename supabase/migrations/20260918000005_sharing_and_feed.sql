-- Sharing, visibility events, and the partner feed.
--
-- What a partner may see of this node's inventory is decided here, by this
-- node, per partner (API-5). Two questions are kept apart:
--   * which listings a partner sees      — audience and direct shares;
--   * which fields of them it sees       — the partner's field groups (LS-14).

-- ---------------------------------------------------------------------------
-- Field groups, per partner
-- ---------------------------------------------------------------------------
alter table public.federation_partners
  add column field_groups text[] not null default '{pricing}'
    check (field_groups <@ array['pricing', 'location_exact', 'media_original', 'documents', 'vessel_identifiers', 'history']);

-- ---------------------------------------------------------------------------
-- Audience, per listing
-- ---------------------------------------------------------------------------
--   everyone — every verified partner;
--   selected — only the partners it is shared with directly;
--   none     — no partner. Direct shares are kept, so hiding a listing for a
--              while does not destroy the selection.
alter table public.listings
  add column audience text not null default 'everyone' check (audience in ('everyone', 'selected', 'none'));

-- Sharing is not an edit. Changing who sees a listing leaves the listing, and
-- its wire timestamp, exactly as they were: the partners affected are told
-- through a visibility event instead, and nobody else is told anything. So the
-- stamping trigger is restated here with `audience` left out of the comparison.
create or replace function private.listings_guard() returns trigger
  language plpgsql set search_path = ''
as $$
declare
  v_unseen text[] := array['assigned_broker_id', 'audience', 'updated_at', 'federation_updated_at', 'listed_at'];
begin
  if new.uuid <> old.uuid then
    raise exception 'A listing''s UUID never changes (ID-1).' using errcode = 'P0001';
  end if;
  if new.listing_type <> old.listing_type then
    raise exception 'A listing''s type is chosen at creation and cannot change. Create a second listing for the same vessel.' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft'       and new.status in ('active', 'withdrawn'))
    or (old.status = 'active'      and new.status in ('under_offer', 'sold', 'withdrawn'))
    or (old.status = 'under_offer' and new.status in ('active', 'sold', 'withdrawn')))
  then
    raise exception 'A listing cannot go from % to % (ID-8). Sold and withdrawn are final: a returning vessel gets a new listing.', old.status, new.status
      using errcode = 'P0001';
  end if;

  if new.status = 'active' and new.listed_at is null then
    new.listed_at := clock_timestamp();
  end if;
  new.updated_at := clock_timestamp();

  -- clock_timestamp(), not now(): now() is when the transaction began, so a slow
  -- transaction would commit a stamp older than one a partner has already
  -- polled past, and that partner would never see the change.
  if (to_jsonb(new) - v_unseen) is distinct from (to_jsonb(old) - v_unseen) then
    new.federation_updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create table public.listing_shares (
  listing_id bigint not null references public.listings (id) on delete cascade,
  partner_id bigint not null references public.federation_partners (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (listing_id, partner_id)
);

create index listing_shares_partner_id_idx on public.listing_shares (partner_id);

-- The one statement of the visibility rule. Everything that needs to know
-- whether a partner sees a listing asks this — the feed, the single-listing
-- endpoint, and the before/after comparison that writes visibility events.
-- A draft is never visible (LS-7); a partner that is not verified sees
-- nothing (FP-13).
create function private.listing_visible_to(p_listing public.listings, p_partner public.federation_partners) returns boolean
  language sql stable set search_path = ''
as $$
  select p_listing.status <> 'draft'
     and p_partner.trust_level = 'verified'
     and (p_listing.audience = 'everyone'
          or (p_listing.audience = 'selected'
              and exists (select 1 from public.listing_shares s where s.listing_id = p_listing.id and s.partner_id = p_partner.id)));
$$;

-- ---------------------------------------------------------------------------
-- Visibility events
-- ---------------------------------------------------------------------------
-- Append-only. One row each time a sharing change makes a listing appear to,
-- or disappear from, a partner. They exist for one reason: a polling partner
-- must never miss a removal (API-3). Unsharing does not change the listing, so
-- its own timestamp does not move — the event's does, and the feed orders on
-- whichever is later.

create table public.visibility_events (
  id          bigint generated always as identity primary key,
  listing_id  bigint not null references public.listings (id) on delete cascade,
  partner_id  bigint not null references public.federation_partners (id) on delete cascade,
  visible     boolean not null,
  occurred_at timestamptz not null default clock_timestamp()
);

create index visibility_events_pair_idx on public.visibility_events (partner_id, listing_id, id desc);
create index visibility_events_listing_id_idx on public.visibility_events (listing_id);

create function private.visibility_events_are_append_only() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  raise exception 'Visibility events are append-only.' using errcode = 'P0001';
end;
$$;

create trigger visibility_events_no_update before update on public.visibility_events
  for each row execute function private.visibility_events_are_append_only();

-- Changes who a listing is shared with, and records what that changed.
--
-- The order inside is the point: read who sees the listing, WRITE THE NEW
-- STATE, read again, and only then record the differences. An event written
-- before the state it describes is an event that, read by anything reacting
-- to it, serialises the old visibility — a listing where a tombstone belongs.
create function public.set_listing_sharing(p_listing_id bigint, p_audience text, p_partner_ids bigint[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_listing public.listings;
  v_before  bigint[];
  v_changed integer;
begin
  -- SECURITY DEFINER, because the caller may not write events. So the caller's
  -- right to change this listing is established here: editors and above, or
  -- the broker the listing is assigned to. The service role has no JWT and is
  -- let through.
  select * into v_listing from public.listings where id = p_listing_id for update;
  if not found then
    raise exception 'No such listing.' using errcode = 'P0002';
  end if;
  -- `is not distinct from`, never `=`: for an unassigned listing `=` yields NULL,
  -- NULL makes the whole condition NULL, and `if NULL` does not raise — which
  -- would let any broker reshare every unassigned listing.
  if (select auth.uid()) is not null
     and not ((select private.current_role_rank()) >= 60
              or ((select private.current_role_rank()) = 40 and v_listing.assigned_broker_id is not distinct from (select auth.uid())))
  then
    raise exception 'Not allowed to change how this listing is shared.' using errcode = '42501';
  end if;

  select coalesce(array_agg(p.id), '{}') into v_before
    from public.federation_partners p where private.listing_visible_to(v_listing, p);

  update public.listings set audience = p_audience where id = p_listing_id returning * into v_listing;
  delete from public.listing_shares where listing_id = p_listing_id and partner_id <> all (coalesce(p_partner_ids, '{}'));
  insert into public.listing_shares (listing_id, partner_id)
    select p_listing_id, unnest(coalesce(p_partner_ids, '{}'))
    on conflict do nothing;

  insert into public.visibility_events (listing_id, partner_id, visible)
    select p_listing_id, p.id, private.listing_visible_to(v_listing, p)
      from public.federation_partners p
     where private.listing_visible_to(v_listing, p) <> (p.id = any (v_before));
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- The feed
-- ---------------------------------------------------------------------------
-- One careful statement. For one partner, in (effective time, id) order:
--   * a listing it can see, and that is live             → the listing;
--   * a listing it can see, that has ended                → a tombstone with the real status;
--   * a listing it can no longer see, having seen it      → a tombstone, `withdrawn`, stamped
--     at the moment it was unshared — indistinguishable from a real withdrawal;
--   * a listing it has never been able to see, or a draft → nothing at all.
--
-- Keyset pagination on (effective_at, listing_id): stable under concurrent
-- writes, where an offset would skip or repeat rows. `effective_at` is returned
-- as text so that the cursor keeps Postgres's microseconds, which a JavaScript
-- Date would round away.

create function public.feed_for_partner(
  p_partner_id bigint,
  p_since      timestamptz,
  p_after_at   timestamptz,
  p_after_id   bigint,
  p_limit      integer
) returns table (listing_id bigint, listing_uuid uuid, effective_at text, kind text, tombstone_status text, tombstone_at timestamptz)
  language sql stable security definer set search_path = ''
as $$
  with partner as (
    select * from public.federation_partners where id = p_partner_id
  ), candidates as (
    select l.id, l.uuid, l.status, l.federation_updated_at,
           private.listing_visible_to(l, partner) as visible,
           e.visible as last_event_visible, e.occurred_at as last_event_at
      from public.listings l
     cross join partner
      left join lateral (
             select ev.visible, ev.occurred_at from public.visibility_events ev
              where ev.partner_id = p_partner_id and ev.listing_id = l.id
              order by ev.id desc limit 1) e on true
     where l.status <> 'draft'
       -- Ended listings are announced for twelve months, then drop out of the feed.
       and not (l.status in ('sold', 'withdrawn') and l.federation_updated_at < now() - interval '12 months')
  ), feed as (
    select id, uuid, status, visible,
           greatest(federation_updated_at, coalesce(last_event_at, federation_updated_at)) as effective_at,
           last_event_at
      from candidates
     -- Visible now, or seen once and since hidden. Never-seen listings drop out here.
     where visible or last_event_visible is false
  )
  select id, uuid, to_char(effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         case when visible and status not in ('sold', 'withdrawn') then 'listing' else 'tombstone' end,
         case when not visible then 'withdrawn' when status in ('sold', 'withdrawn') then status end,
         case when not visible then last_event_at when status in ('sold', 'withdrawn') then effective_at end
    from feed
   where (p_since is null or effective_at >= p_since)
     and (p_after_at is null or (effective_at, id) > (p_after_at, p_after_id))
   order by effective_at, id
   limit p_limit;
$$;

-- Dereferencing one canonical URI. The answer is the listing's id, or nothing:
-- "you may not see it", "it is a draft" and "it never existed" are one and the
-- same answer, so a partner can learn nothing by probing UUIDs.
create function public.listing_for_partner(p_partner_id bigint, p_uuid uuid) returns bigint
  language sql stable security definer set search_path = ''
as $$
  select l.id from public.listings l, public.federation_partners p
   where l.uuid = p_uuid and p.id = p_partner_id and private.listing_visible_to(l, p);
$$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------
alter table public.listing_shares enable row level security;
alter table public.visibility_events enable row level security;

-- Readable by whoever can read the listing (the listings policies apply to the subquery).
create policy "Shares are readable with their listing" on public.listing_shares for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_shares.listing_id));
create policy "Super admins read visibility events" on public.visibility_events for select to authenticated
  using ((select private.current_role_rank()) >= 100);

revoke all on public.listing_shares, public.visibility_events from anon, authenticated;
grant select on public.listing_shares, public.visibility_events to authenticated;
grant all on public.listing_shares, public.visibility_events to service_role;

-- What a signed-in user may set on a listing, column by column. A column-level
-- REVOKE has no effect while a table-level UPDATE grant exists, so the table
-- grant goes and the allowed columns are named. Left out on purpose: `audience`
-- (changed only through set_listing_sharing(), so that no sharing change can
-- happen without its events), `uuid` and `listing_type` (immutable), and the
-- timestamps the triggers own.
revoke update on public.listings from authenticated;
grant update (
  vessel_id, status, name, summary, condition, agreement_type, co_brokerage,
  price_amount, price_currency, price_on_application, price_starting,
  location_display, location_city, location_state, location_country, location_marina, location_lat, location_lon,
  brokers, specifications, descriptions, features, media, charter, usage, compliance, assigned_broker_id
) on public.listings to authenticated;

revoke all on function public.set_listing_sharing(bigint, text, bigint[]) from public, anon;
revoke all on function public.feed_for_partner(bigint, timestamptz, timestamptz, bigint, integer) from public, anon, authenticated;
revoke all on function public.listing_for_partner(bigint, uuid) from public, anon, authenticated;
grant execute on function public.set_listing_sharing(bigint, text, bigint[]) to authenticated, service_role;
grant execute on function public.feed_for_partner(bigint, timestamptz, timestamptz, bigint, integer) to service_role;
grant execute on function public.listing_for_partner(bigint, uuid) to service_role;
