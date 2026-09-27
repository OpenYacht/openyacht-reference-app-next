-- Partner groups, curated partners, and the visibility rule they share with
-- the other OpenYacht implementations.
--
-- A partner group is a named set of partners, used as audience shorthand: a
-- listing shared with a group reaches its members, resolved when the feed is
-- read, so a change of membership changes nothing on any listing.
--
-- A partner's sharing scope is `standard` (every listing whose audience is
-- everyone, plus what is shared with it) or `curated` (a show organiser, a
-- trial, a press feed: only what is shared with it, directly or through a
-- group). Shares become additive, so an everyone-audience listing can reach a
-- curated partner without changing anyone else's view:
--
--   visible ⇔ audience ≠ none AND (shared with the partner directly
--                                   OR shared with a group it belongs to
--                                   OR (audience = everyone AND scope = standard))
--
-- For a standard partner this is exactly the earlier rule. It is authority-side
-- policy only: nothing on the wire changes, a listing a partner may not see is
-- still NOT_FOUND, and becoming hidden is still a tombstone.
--
-- Every change that can move visibility — a listing's sharing, a group's
-- members or its listings, a partner's scope — records one visibility event
-- per (listing, partner) whose visibility changed. That is what moves the
-- listing in that partner's feed; no listing's wire timestamp moves.

alter table public.federation_partners
  add column sharing_scope text not null default 'standard' check (sharing_scope in ('standard', 'curated'));

create table public.partner_groups (
  id         bigint generated always as identity primary key,
  name       text not null unique check (btrim(name) <> ''),
  created_at timestamptz not null default now()
);

create table public.partner_group_members (
  group_id   bigint not null references public.partner_groups (id) on delete cascade,
  partner_id bigint not null references public.federation_partners (id) on delete cascade,
  primary key (group_id, partner_id)
);
create index partner_group_members_partner_id_idx on public.partner_group_members (partner_id);

create table public.listing_group_shares (
  listing_id bigint not null references public.listings (id) on delete cascade,
  group_id   bigint not null references public.partner_groups (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (listing_id, group_id)
);
create index listing_group_shares_group_id_idx on public.listing_group_shares (group_id);

alter table public.partner_groups enable row level security;
alter table public.partner_group_members enable row level security;
alter table public.listing_group_shares enable row level security;

-- Groups are chosen from when sharing a listing, so whoever may share listings
-- reads their names; who is in them is federation configuration.
create policy "Listing and federation managers read groups" on public.partner_groups for select to authenticated
  using ((select private.has_permission('federation.manage'))
         or (select private.has_permission('listings.manage'))
         or (select private.has_permission('listings.manage_own')));
create policy "Federation managers read group members" on public.partner_group_members for select to authenticated
  using ((select private.has_permission('federation.manage')));
create policy "Group shares are readable with their listing" on public.listing_group_shares for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_group_shares.listing_id));

-- Written only through the functions below, which record the visibility they change.
revoke all on public.partner_groups, public.partner_group_members, public.listing_group_shares from anon, authenticated;
grant select on public.partner_groups, public.partner_group_members, public.listing_group_shares to authenticated;
grant all on public.partner_groups, public.partner_group_members, public.listing_group_shares to service_role;

-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------

create or replace function private.listing_visible_to(p_listing public.listings, p_partner public.federation_partners) returns boolean
  language sql stable set search_path = ''
as $$
  select p_listing.status <> 'draft'
     and p_partner.trust_level = 'verified'
     and p_listing.audience <> 'none'
     and (exists (select 1 from public.listing_shares s where s.listing_id = p_listing.id and s.partner_id = p_partner.id)
          or exists (select 1
                       from public.listing_group_shares gs
                       join public.partner_group_members m on m.group_id = gs.group_id
                      where gs.listing_id = p_listing.id and m.partner_id = p_partner.id)
          or (p_listing.audience = 'everyone' and p_partner.sharing_scope = 'standard'));
$$;

-- Visibility bookkeeping for changes that touch many listings at once: take
-- the visible (listing, partner) pairs for the partners concerned, make the
-- change, then record an event for every pair that moved.
create function private.visible_pairs(p_partner_ids bigint[]) returns text[]
  language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(l.id || ':' || p.id), '{}')
    from public.listings l
    join public.federation_partners p on p.id = any (p_partner_ids)
   where private.listing_visible_to(l, p);
$$;

create function private.record_visibility_changes(p_partner_ids bigint[], p_before text[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.visibility_events (listing_id, partner_id, visible)
    select l.id, p.id, private.listing_visible_to(l, p)
      from public.listings l
      join public.federation_partners p on p.id = any (p_partner_ids)
     where private.listing_visible_to(l, p) <> ((l.id || ':' || p.id) = any (p_before));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.visible_pairs(bigint[]) from public;
revoke all on function private.record_visibility_changes(bigint[], text[]) from public;

-- ---------------------------------------------------------------------------
-- Sharing a listing: with partners and with groups
-- ---------------------------------------------------------------------------
-- The picker is the source of truth for shares under every audience: they
-- persist under `everyone` (where they reach curated partners) and under
-- `none` (so hiding a listing and showing it again keeps its lineup).

drop function public.set_listing_sharing(bigint, text, bigint[]);

create function public.set_listing_sharing(p_listing_id bigint, p_audience text, p_partner_ids bigint[], p_group_ids bigint[] default '{}')
  returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_listing public.listings;
  v_before  bigint[];
  v_changed integer;
begin
  -- SECURITY DEFINER, because the caller may not write events. So the caller's
  -- right to change this listing is established here: listings.manage, or
  -- listings.manage_own for a listing assigned to the caller. The service role
  -- has no JWT and is let through.
  select * into v_listing from public.listings where id = p_listing_id for update;
  if not found then
    raise exception 'No such listing.' using errcode = 'P0002';
  end if;
  -- `is not distinct from`, never `=`: for an unassigned listing `=` yields NULL,
  -- NULL makes the whole condition NULL, and `if NULL` does not raise — which
  -- would let any broker reshare every unassigned listing.
  if (select auth.uid()) is not null
     and not ((select private.has_permission('listings.manage'))
              or ((select private.has_permission('listings.manage_own')) and v_listing.assigned_broker_id is not distinct from (select auth.uid())))
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
  delete from public.listing_group_shares where listing_id = p_listing_id and group_id <> all (coalesce(p_group_ids, '{}'));
  insert into public.listing_group_shares (listing_id, group_id)
    select p_listing_id, unnest(coalesce(p_group_ids, '{}'))
    on conflict do nothing;

  insert into public.visibility_events (listing_id, partner_id, visible)
    select p_listing_id, p.id, private.listing_visible_to(v_listing, p)
      from public.federation_partners p
     where private.listing_visible_to(v_listing, p) <> (p.id = any (v_before));
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke all on function public.set_listing_sharing(bigint, text, bigint[], bigint[]) from public, anon;
grant execute on function public.set_listing_sharing(bigint, text, bigint[], bigint[]) to authenticated, service_role;

-- Groups to choose from when sharing: names only.
create function public.shareable_groups() returns table (id bigint, name text)
  language sql stable security definer set search_path = ''
as $$
  select g.id, g.name
    from public.partner_groups g
   where (select private.has_permission('listings.manage')) or (select private.has_permission('listings.manage_own'))
   order by g.name;
$$;
revoke all on function public.shareable_groups() from public, anon;
grant execute on function public.shareable_groups() to authenticated;

-- ---------------------------------------------------------------------------
-- Partner-side changes: scope, direct shares by type, groups
-- ---------------------------------------------------------------------------

create function public.set_partner_sharing_scope(p_partner_id bigint, p_scope text) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_before text[];
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Changing a partner''s sharing scope needs the federation.manage permission.' using errcode = '42501';
  end if;
  if p_scope not in ('standard', 'curated') then
    raise exception 'Unknown sharing scope.' using errcode = 'P0001';
  end if;
  perform 1 from public.federation_partners where id = p_partner_id for update;
  if not found then
    raise exception 'No such partner.' using errcode = 'P0002';
  end if;

  v_before := private.visible_pairs(array[p_partner_id]);
  update public.federation_partners set sharing_scope = p_scope where id = p_partner_id;
  return private.record_visibility_changes(array[p_partner_id], v_before);
end;
$$;

-- The partner-side picker: the listings of one type shared with this partner
-- directly. Scoped to a type on purpose — a save from the sale list must never
-- unshare the partner's charters because they were not on screen.
create function public.set_partner_direct_shares(p_partner_id bigint, p_listing_type text, p_listing_ids bigint[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_before text[];
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Choosing what a partner receives needs the federation.manage permission.' using errcode = '42501';
  end if;
  if p_listing_type not in ('sale', 'charter') then
    raise exception 'Unknown listing type.' using errcode = 'P0001';
  end if;
  perform 1 from public.federation_partners where id = p_partner_id for update;
  if not found then
    raise exception 'No such partner.' using errcode = 'P0002';
  end if;

  v_before := private.visible_pairs(array[p_partner_id]);
  delete from public.listing_shares s
   using public.listings l
   where s.listing_id = l.id and s.partner_id = p_partner_id and l.listing_type = p_listing_type
     and l.id <> all (coalesce(p_listing_ids, '{}'));
  insert into public.listing_shares (listing_id, partner_id)
    select l.id, p_partner_id from public.listings l
     where l.id = any (coalesce(p_listing_ids, '{}')) and l.listing_type = p_listing_type
    on conflict do nothing;
  return private.record_visibility_changes(array[p_partner_id], v_before);
end;
$$;

-- Creates or changes a group: its name and members. Returns the group's id.
create function public.save_partner_group(p_group_id bigint, p_name text, p_member_ids bigint[]) returns bigint
  language plpgsql security definer set search_path = ''
as $$
declare
  v_id       bigint := p_group_id;
  v_affected bigint[];
  v_before   text[];
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Changing partner groups needs the federation.manage permission.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'A group needs a name.' using errcode = 'P0001';
  end if;

  if v_id is not null then
    perform 1 from public.partner_groups where id = v_id for update;
    if not found then
      raise exception 'No such group.' using errcode = 'P0002';
    end if;
  end if;

  -- Everyone who was or will be a member may see something change.
  select coalesce(array_agg(distinct x), '{}') into v_affected
    from (select partner_id as x from public.partner_group_members where group_id = v_id
          union select unnest(coalesce(p_member_ids, '{}'))) members;
  v_before := private.visible_pairs(v_affected);

  if v_id is null then
    insert into public.partner_groups (name) values (btrim(p_name)) returning id into v_id;
  else
    update public.partner_groups set name = btrim(p_name) where id = v_id;
  end if;
  delete from public.partner_group_members where group_id = v_id and partner_id <> all (coalesce(p_member_ids, '{}'));
  insert into public.partner_group_members (group_id, partner_id)
    select v_id, unnest(coalesce(p_member_ids, '{}'))
    on conflict do nothing;

  perform private.record_visibility_changes(v_affected, v_before);
  return v_id;
end;
$$;

create function public.delete_partner_group(p_group_id bigint) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_affected bigint[];
  v_before   text[];
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Changing partner groups needs the federation.manage permission.' using errcode = '42501';
  end if;
  perform 1 from public.partner_groups where id = p_group_id for update;
  if not found then
    raise exception 'No such group.' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(partner_id), '{}') into v_affected from public.partner_group_members where group_id = p_group_id;
  v_before := private.visible_pairs(v_affected);
  delete from public.partner_groups where id = p_group_id;
  return private.record_visibility_changes(v_affected, v_before);
end;
$$;

revoke all on function public.set_partner_sharing_scope(bigint, text) from public, anon;
revoke all on function public.set_partner_direct_shares(bigint, text, bigint[]) from public, anon;
revoke all on function public.save_partner_group(bigint, text, bigint[]) from public, anon;
revoke all on function public.delete_partner_group(bigint) from public, anon;
grant execute on function public.set_partner_sharing_scope(bigint, text) to authenticated, service_role;
grant execute on function public.set_partner_direct_shares(bigint, text, bigint[]) to authenticated, service_role;
grant execute on function public.save_partner_group(bigint, text, bigint[]) to authenticated, service_role;
grant execute on function public.delete_partner_group(bigint) to authenticated, service_role;
