-- What the listing and partner screens need from the database.

-- ---------------------------------------------------------------------------
-- Partners a listing can be shared with
-- ---------------------------------------------------------------------------
-- Whoever shares a listing has to choose among the partners, but the partners
-- table is federation configuration, readable by super admins alone. This
-- returns just enough to choose by — a name and a domain, for verified
-- partners — to anyone who may edit listings, and nothing about keys, trust
-- history or sync state.
create function public.shareable_partners() returns table (id bigint, node_name text, domain text)
  language sql stable security definer set search_path = ''
as $$
  select p.id, p.node_name, p.domain
    from public.federation_partners p
   where p.trust_level = 'verified'
     and coalesce((select private.current_role_rank()) >= 40, false)
   order by p.node_name;
$$;

-- ---------------------------------------------------------------------------
-- Changing what a partner is granted
-- ---------------------------------------------------------------------------
-- A partner's field groups decide which values it is served (LS-14). Changing
-- them changes what every listing looks like to that partner — yet no listing
-- has changed, so no timestamp moves, and a polling partner would go on holding
-- the old view indefinitely: a price it may no longer see, or one it now may
-- and never receives. So the change re-announces, to that partner alone, every
-- listing it can see: one visibility event each, which moves the listing's
-- effective time in that partner's feed and nobody else's.
create function public.set_partner_field_groups(p_partner_id bigint, p_field_groups text[]) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_partner public.federation_partners;
  v_count   integer;
begin
  -- coalesce: a NULL comparison must refuse, not pass.
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 100, false) then
    raise exception 'Only a super admin may change what a partner is granted.' using errcode = '42501';
  end if;

  select * into v_partner from public.federation_partners where id = p_partner_id for update;
  if not found then
    raise exception 'No such partner.' using errcode = 'P0002';
  end if;
  -- Order does not matter, and an unchanged set announces nothing.
  if (select array_agg(g order by g) from unnest(v_partner.field_groups) g)
     is not distinct from
     (select array_agg(g order by g) from unnest(coalesce(p_field_groups, '{}')) g)
  then
    return 0;
  end if;

  -- State first, then the events that describe it.
  update public.federation_partners set field_groups = coalesce(p_field_groups, '{}') where id = p_partner_id returning * into v_partner;

  insert into public.visibility_events (listing_id, partner_id, visible)
    select l.id, p_partner_id, true
      from public.listings l
     where private.listing_visible_to(l, v_partner);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Field groups change only through the function above, so that the change is
-- always announced. As with listings, a column-level REVOKE would do nothing
-- beside a table-level grant: the table grant goes, and the columns an
-- administrator may set directly are named.
revoke update on public.federation_partners from authenticated;
grant update (
  node_uuid, node_name, keys_json, keys_fetched_at, pinned_key_id, trust_level, approved_by, acceptance_policy,
  sync_watermark, last_ok_at, last_attempt_at, consecutive_failures, awaiting_approval, request_sent_at
) on public.federation_partners to authenticated;

revoke all on function public.shareable_partners() from public, anon;
revoke all on function public.set_partner_field_groups(bigint, text[]) from public, anon;
grant execute on function public.shareable_partners() to authenticated, service_role;
grant execute on function public.set_partner_field_groups(bigint, text[]) to authenticated, service_role;
