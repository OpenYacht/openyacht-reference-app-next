-- Authority role: this node's own vessels and listings.
--
-- Own listings and received copies never share a table (ID-4, ID-5): this one
-- holds what this node is the authority for, listing_copies holds what it is
-- not. The rules that must never break are enforced here, in the database, so
-- that no code path — an admin screen, an import, a one-off script — can
-- bypass them.

-- ---------------------------------------------------------------------------
-- Vessels
-- ---------------------------------------------------------------------------
-- The physical boat. Identifiers are for matching, not authority
-- (yacht-identity.md §Vessel Identity). A vessel for sale and for charter is
-- one vessel with two listings.

create table public.vessels (
  id              bigint generated always as identity primary key,
  hin             text,
  imo             text,
  mmsi            text,
  official_number text,
  builder_name    text,
  -- A slug is a claim of membership in the vendored builder registry (LS-11);
  -- it is validated against that registry at data entry. Unlisted builders
  -- have a name and no slug.
  builder_slug    text,
  model_name      text,
  -- Builder-scoped and node-curated; models have no shared registry.
  model_slug      text,
  year_built      integer check (year_built between 1800 and 2200),
  refit_year      integer check (refit_year between 1800 and 2200),
  loa_m           numeric(7, 2) check (loa_m > 0),
  previous_names  text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint vessels_builder_slug_needs_name check (builder_slug is null or builder_name is not null),
  constraint vessels_model_slug_needs_name check (model_slug is null or model_name is not null)
);

-- ---------------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------------

create table public.listings (
  id                   bigint generated always as identity primary key,
  -- Minted once, here, at creation; never reused, never changed (ID-1). The
  -- canonical URI is https://{identity domain}/openyacht/v1/listings/{uuid}.
  uuid                 uuid not null unique default gen_random_uuid(),
  vessel_id            bigint not null references public.vessels (id) on delete restrict,
  -- Chosen at creation and immutable.
  listing_type         text not null check (listing_type in ('sale', 'charter')),
  -- draft → active ⇄ under_offer → sold | withdrawn (ID-8). A draft is never
  -- distributed (LS-7).
  status               text not null default 'draft' check (status in ('draft', 'active', 'under_offer', 'sold', 'withdrawn')),
  name                 text not null check (name <> ''),
  summary              text,
  condition            text check (condition in ('new', 'used')),
  agreement_type       text check (agreement_type in ('central', 'exclusive', 'open')),
  co_brokerage         boolean,
  -- Money is never a float (API-12). The amount is kept as the decimal string
  -- that goes on the wire, so what is served is byte-for-byte what was entered
  -- and never changes representation behind the listing's back.
  price_amount         text check (price_amount ~ '^[0-9]+(\.[0-9]+)?$'),
  price_currency       text check (price_currency ~ '^[A-Z]{3}$'),
  price_on_application boolean not null default false,
  price_starting       boolean not null default false,
  location_display     text,
  location_city        text,
  location_state       text,
  location_country     text check (location_country ~ '^[A-Z]{2}$'),
  location_marina      text,
  location_lat         double precision check (location_lat between -90 and 90),
  location_lon         double precision check (location_lon between -180 and 180),
  -- The remaining blocks are stored in the wire's own shape, sparsely filled;
  -- serialising completes them (LS-1).
  brokers              jsonb not null default '[]',
  specifications       jsonb not null default '{"power_or_sail": "power"}',
  descriptions         jsonb not null default '[]',
  features             jsonb not null default '[]',
  media                jsonb not null default '{}',
  charter              jsonb,
  usage                jsonb not null default '{}',
  compliance           jsonb not null default '{}',
  listed_at            timestamptz,
  -- The wire `updated_at` and the sync cursor (API-4): the last change to
  -- anything a partner can see. Stamped by trigger, never by hand.
  federation_updated_at timestamptz not null default clock_timestamp(),
  -- A broker sees and edits only the listings assigned to them.
  assigned_broker_id   uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint listings_sale_has_no_charter_block check (listing_type = 'charter' or charter is null),
  constraint listings_charter_has_no_price check (listing_type = 'sale' or (price_amount is null and price_currency is null)),
  constraint listings_amount_and_currency_together check ((price_amount is null) = (price_currency is null)),
  constraint listings_coordinates_together check ((location_lat is null) = (location_lon is null)),
  constraint listings_power_or_sail_present check (specifications ->> 'power_or_sail' in ('power', 'sail'))
);

create index listings_vessel_id_idx on public.listings (vessel_id);
create index listings_assigned_broker_id_idx on public.listings (assigned_broker_id);
-- The feed reads distributed listings in (federation_updated_at, id) order.
create index listings_feed_idx on public.listings (federation_updated_at, id) where status <> 'draft';

create function private.listings_guard() returns trigger
  language plpgsql set search_path = ''
as $$
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

  -- Stamp the wire timestamp when anything a partner can see has changed.
  -- clock_timestamp(), not now(): now() is when the transaction began, so a slow
  -- transaction would commit a stamp older than one a partner has already
  -- polled past, and that partner would never see the change.
  -- Who a listing is assigned to is the one column that is not on the wire.
  if (to_jsonb(new) - 'assigned_broker_id' - 'updated_at' - 'federation_updated_at' - 'listed_at')
     is distinct from
     (to_jsonb(old) - 'assigned_broker_id' - 'updated_at' - 'federation_updated_at' - 'listed_at')
  then
    new.federation_updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger listings_guard before update on public.listings
  for each row execute function private.listings_guard();

create function private.listings_set_listed_at() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  if new.status = 'active' and new.listed_at is null then
    new.listed_at := now();
  end if;
  return new;
end;
$$;

create trigger listings_set_listed_at before insert on public.listings
  for each row execute function private.listings_set_listed_at();

-- The vessel block is on the wire, so editing a vessel is a change to every
-- listing of it.
create function private.vessels_touch_listings() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    update public.listings set federation_updated_at = clock_timestamp() where vessel_id = new.id;
  end if;
  return new;
end;
$$;

create trigger vessels_touch_listings before update on public.vessels
  for each row execute function private.vessels_touch_listings();

-- ---------------------------------------------------------------------------
-- Price history
-- ---------------------------------------------------------------------------
-- Append-only. Every asking price a sale listing has had; the newest entry is
-- always the current price (LS-10). Written by trigger when the price changes,
-- so it cannot drift from the listing — and nothing can rewrite it.
--
-- History starts when the listing goes live. What a price was while the
-- listing was still a draft was never an asking price, and a partner granted
-- the `history` field group has no business seeing it.

create table public.price_history (
  id         bigint generated always as identity primary key,
  listing_id bigint not null references public.listings (id) on delete cascade,
  amount     text not null check (amount ~ '^[0-9]+(\.[0-9]+)?$'),
  currency   text not null check (currency ~ '^[A-Z]{3}$'),
  -- clock_timestamp(), not now(): two changes in one transaction must keep their order.
  changed_at timestamptz not null default clock_timestamp()
);

create index price_history_listing_id_idx on public.price_history (listing_id, changed_at desc);

create function private.record_price_change() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if new.price_amount is not null
     and new.status <> 'draft'
     and (tg_op = 'INSERT'
          or old.status = 'draft'
          or new.price_amount is distinct from old.price_amount
          or new.price_currency is distinct from old.price_currency)
  then
    insert into public.price_history (listing_id, amount, currency) values (new.id, new.price_amount, new.price_currency);
  end if;
  return null;
end;
$$;

create trigger listings_record_price_change after insert or update on public.listings
  for each row execute function private.record_price_change();

create function private.price_history_is_append_only() returns trigger
  language plpgsql set search_path = ''
as $$
begin
  raise exception 'Price history is append-only.' using errcode = 'P0001';
end;
$$;

create trigger price_history_no_update before update on public.price_history
  for each row execute function private.price_history_is_append_only();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- viewer: read. editor and above: everything. broker: only the listings
-- assigned to them — enforced here, not in the UI.

alter table public.vessels enable row level security;
alter table public.listings enable row level security;
alter table public.price_history enable row level security;

create policy "Role holders read vessels" on public.vessels for select to authenticated
  using ((select private.current_role_rank()) > 0);
create policy "Brokers and above add vessels" on public.vessels for insert to authenticated
  with check ((select private.current_role_rank()) >= 40);
create policy "Editors and above change vessels; brokers change the vessels of their own listings" on public.vessels for update to authenticated
  using (
    (select private.current_role_rank()) >= 60
    or ((select private.current_role_rank()) >= 40
        and exists (select 1 from public.listings l where l.vessel_id = vessels.id and l.assigned_broker_id = (select auth.uid()))))
  with check ((select private.current_role_rank()) >= 40);
create policy "Editors and above delete vessels" on public.vessels for delete to authenticated
  using ((select private.current_role_rank()) >= 60);

create policy "Editors and above read every listing; brokers read their own; viewers read all" on public.listings for select to authenticated
  using (
    (select private.current_role_rank()) >= 60
    or (select private.current_role_rank()) = 20
    or ((select private.current_role_rank()) = 40 and assigned_broker_id = (select auth.uid())));
create policy "Editors add any listing; brokers add listings assigned to themselves" on public.listings for insert to authenticated
  with check (
    (select private.current_role_rank()) >= 60
    or ((select private.current_role_rank()) = 40 and assigned_broker_id = (select auth.uid())));
create policy "Editors change any listing; brokers change their own and cannot reassign them" on public.listings for update to authenticated
  using (
    (select private.current_role_rank()) >= 60
    or ((select private.current_role_rank()) = 40 and assigned_broker_id = (select auth.uid())))
  with check (
    (select private.current_role_rank()) >= 60
    or ((select private.current_role_rank()) = 40 and assigned_broker_id = (select auth.uid())));
-- Only a draft can be deleted: once distributed, a listing ends by being
-- withdrawn or sold, which partners are told about. Deleting it would leave
-- them holding a copy with no tombstone.
create policy "Editors and above delete drafts" on public.listings for delete to authenticated
  using ((select private.current_role_rank()) >= 60 and status = 'draft');

create policy "Price history is readable with its listing" on public.price_history for select to authenticated
  using (exists (select 1 from public.listings l where l.id = price_history.listing_id));

revoke all on public.vessels, public.listings, public.price_history from anon, authenticated;
grant select, insert, update, delete on public.vessels, public.listings to authenticated;
grant select on public.price_history to authenticated;
grant all on public.vessels, public.listings, public.price_history to service_role;
