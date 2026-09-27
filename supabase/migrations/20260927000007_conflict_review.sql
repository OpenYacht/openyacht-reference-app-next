-- The human review of a vessel-identity conflict (ID-9). When live listings
-- from different authorities name the same vessel by HIN or IMO, both copies
-- are kept and flagged, and nothing resolves the conflict automatically. A
-- person may review it and choose to proceed; the review holds for the exact
-- set of rivals it was made against, so a new match always reaches a person
-- even if an earlier one was dismissed.

alter table public.listing_copies
  -- The canonical URIs of the rival copies, sorted. Written by the sync engine.
  add column conflicts_with       text[] not null default '{}',
  add column conflict_reviewed_at timestamptz,
  add column conflict_reviewed_by uuid references auth.users (id) on delete set null,
  add constraint listing_copies_review_needs_a_conflict check (conflict_reviewed_at is null or in_conflict);

create index listing_copies_conflict_reviewed_by_idx on public.listing_copies (conflict_reviewed_by);

-- Existing flags learn their rivals, by the same rule the sync engine applies.
update public.listing_copies c
   set conflicts_with = coalesce((
         select array_agg(o.canonical_uri order by o.canonical_uri)
           from public.listing_copies o
          where o.tombstoned_at is null and o.partner_id <> c.partner_id and o.hard_identifiers && c.hard_identifiers), '{}')
 where c.in_conflict;

-- Copies are written by the sync engine only (ID-5), so the review is recorded
-- here, for whoever may manage listings, and touches nothing else.
create function public.review_copy_conflict(p_canonical_uri text) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not (select private.has_permission('listings.manage')) then
    raise exception 'Reviewing a conflict needs the listings.manage permission.' using errcode = '42501';
  end if;
  update public.listing_copies
     set conflict_reviewed_at = now(), conflict_reviewed_by = (select auth.uid())
   where canonical_uri = p_canonical_uri and in_conflict and conflict_reviewed_at is null;
  if not found then
    raise exception 'No unreviewed conflict on that listing.' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.review_copy_conflict(text) from public, anon;
grant execute on function public.review_copy_conflict(text) to authenticated;

-- Ending a partnership keeps the rival sets true as well.
create or replace function public.end_partnership(p_partner_id bigint) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_ended integer;
begin
  -- The caller may not write copies, so their right to end the partnership is
  -- established here. The service role (no JWT) is let through.
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Ending a partnership needs the federation.manage permission.' using errcode = '42501';
  end if;

  update public.federation_partners
     set trust_level = 'blocked', approved_by = null, sync_watermark = null
   where id = p_partner_id;
  if not found then
    raise exception 'No such partner.' using errcode = 'P0002';
  end if;

  -- A missing usage block is read as the protocol's recommended default: the
  -- data goes with the partnership. tombstoned_at takes the version held, so
  -- a later cold sync re-applies that same version rather than calling it
  -- unchanged.
  update public.listing_copies
     set payload = null,
         tombstoned_at = listing_updated_at,
         display_state = 'held',
         held_reasons = array['The partnership has ended, and the listing''s usage terms end use of its data with it.'],
         in_conflict = false,
         conflicts_with = '{}',
         conflict_reviewed_at = null,
         conflict_reviewed_by = null
   where partner_id = p_partner_id
     and tombstoned_at is null
     and coalesce((payload -> 'usage' ->> 'expires_with_listing')::boolean, true);
  get diagnostics v_ended = row_count;

  -- ID-9 conflicts are between live copies from different authorities. The
  -- rivals left behind lose the ended copies from their sets; a changed set
  -- clears an earlier review, as the sync engine does.
  update public.listing_copies c
     set conflicts_with = r.rivals,
         in_conflict = cardinality(r.rivals) > 0,
         conflict_reviewed_at = null,
         conflict_reviewed_by = null
    from (select c2.canonical_uri,
                 coalesce((select array_agg(o.canonical_uri order by o.canonical_uri)
                             from public.listing_copies o
                            where o.tombstoned_at is null
                              and o.partner_id <> c2.partner_id
                              and o.hard_identifiers && c2.hard_identifiers), '{}') as rivals
            from public.listing_copies c2
           where c2.in_conflict and c2.tombstoned_at is null) r
   where c.canonical_uri = r.canonical_uri
     and c.conflicts_with is distinct from r.rivals;

  return v_ended;
end;
$$;
