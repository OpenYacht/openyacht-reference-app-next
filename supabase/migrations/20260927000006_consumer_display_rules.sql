-- Two consumer-side display rules, both local and neither on the wire.
--
--   import_types      which of a partner's listing types this node displays
--                     (both, sale or charter). Every copy is still stored, so
--                     loosening it displays the backlog without a re-sync.
--   group policies    a partner group may carry an acceptance policy; a
--                     member's effective policy is the most permissive of its
--                     own and its groups'. Groups loosen, never tighten.
--
-- The rules themselves live in the federation core (federation/copies.ts);
-- this stores what they read.

alter table public.federation_partners
  add column import_types text not null default 'both' check (import_types in ('both', 'sale', 'charter'));
-- Set on the partner screen, column by column like the rest of this table.
grant update (import_types) on public.federation_partners to authenticated;

alter table public.partner_groups
  add column acceptance_policy text check (acceptance_policy in ('accept_all', 'accept_matching', 'hold'));

-- save_partner_group() gains the policy.
drop function public.save_partner_group(bigint, text, bigint[]);

create function public.save_partner_group(p_group_id bigint, p_name text, p_member_ids bigint[], p_acceptance_policy text default null)
  returns bigint
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
  if p_acceptance_policy is not null and p_acceptance_policy not in ('accept_all', 'accept_matching', 'hold') then
    raise exception 'Unknown acceptance policy.' using errcode = 'P0001';
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
    insert into public.partner_groups (name, acceptance_policy) values (btrim(p_name), p_acceptance_policy) returning id into v_id;
  else
    update public.partner_groups set name = btrim(p_name), acceptance_policy = p_acceptance_policy where id = v_id;
  end if;
  delete from public.partner_group_members where group_id = v_id and partner_id <> all (coalesce(p_member_ids, '{}'));
  insert into public.partner_group_members (group_id, partner_id)
    select v_id, unnest(coalesce(p_member_ids, '{}'))
    on conflict do nothing;

  perform private.record_visibility_changes(v_affected, v_before);
  return v_id;
end;
$$;

revoke all on function public.save_partner_group(bigint, text, bigint[], text) from public, anon;
grant execute on function public.save_partner_group(bigint, text, bigint[], text) to authenticated, service_role;
