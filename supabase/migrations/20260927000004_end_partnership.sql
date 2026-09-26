-- Ending a partnership. Spec: yacht-identity.md ID-10 — when a listing's
-- usage says expires_with_listing, all use of its data ceases when the listing
-- ends *or the partnership terminates*.
--
-- A partner that has delivered listings is never deleted (its row anchors
-- their provenance, ID-3); the partnership ends by blocking it. Until now that
-- only stopped synchronisation, and the stored copies stayed usable. Blocking
-- now also drops the data of every copy whose terms end with the partnership,
-- exactly as a tombstone would, and clears the sync watermark, so that if the
-- partner is ever approved again a cold sync brings back everything it still
-- shares. Copies whose terms allow keeping them stay, and go stale like any
-- unreachable partner's (FP-15).

create function public.end_partnership(p_partner_id bigint) returns integer
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
         in_conflict = false
   where partner_id = p_partner_id
     and tombstoned_at is null
     and coalesce((payload -> 'usage' ->> 'expires_with_listing')::boolean, true);
  get diagnostics v_ended = row_count;

  -- ID-9 conflicts are between live copies from different authorities; copies
  -- whose only rival was just ended are no longer in conflict.
  update public.listing_copies c
     set in_conflict = false
   where c.in_conflict
     and c.tombstoned_at is null
     and not exists (
           select 1 from public.listing_copies o
            where o.tombstoned_at is null
              and o.partner_id <> c.partner_id
              and o.hard_identifiers && c.hard_identifiers);

  return v_ended;
end;
$$;

revoke all on function public.end_partnership(bigint) from public, anon;
grant execute on function public.end_partnership(bigint) to authenticated, service_role;
