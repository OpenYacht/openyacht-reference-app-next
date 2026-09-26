-- Permissions: what each role may do, as data a super admin can change.
--
-- Until now each role's powers were written into the policies as ranks
-- (editor and above, super admin only). They become named permissions held
-- by roles, checked with private.has_permission(). The defaults reproduce
-- exactly what the ranks allowed, so nothing changes on migrating.
--
-- Fixed, whatever the matrix says:
--   * super_admin holds every permission, and its row cannot be edited, so a
--     node can never lock itself out;
--   * a role without listings.manage_own and listings.manage still reads
--     every listing: read access comes with holding any role;
--   * the account hierarchy stays by rank: a users.manage holder manages
--     only accounts ranked below their own role (user_management migration).
--
-- Whoever edits the matrix (roles.manage) edits only roles ranked below their
-- own, and grants or withdraws only permissions they hold themselves, so the
-- matrix cannot be used to escalate.

create table public.permissions (
  name        text primary key,
  description text not null,
  position    smallint not null unique
);

insert into public.permissions (name, description, position) values
  ('users.manage',             'Add accounts, give roles and take them away, below their own rank.', 1),
  ('roles.manage',             'Change what each role may do, for roles below their own.',            2),
  ('listings.manage',          'Create, edit, share and delete every listing, with its media.',       3),
  ('listings.manage_own',      'Create, edit and share listings assigned to themselves only.',        4),
  ('federation.manage',        'Partners, what they are granted, signing keys and the sync schedule.', 5),
  ('federation.notifications', 'Be alerted when an unknown node makes contact or a partner''s identity changes.', 6),
  ('activity-log.view',        'Read the record of role changes and federation requests.',            7);

create table public.role_permissions (
  role       text not null references public.roles (name) on delete cascade,
  permission text not null references public.permissions (name) on delete cascade,
  primary key (role, permission),
  -- Implicit and total; never stored, so never removable.
  check (role <> 'super_admin')
);

create index role_permissions_permission_idx on public.role_permissions (permission);

-- The defaults: what the ranks allowed before this migration.
insert into public.role_permissions (role, permission) values
  ('admin',  'users.manage'),
  ('admin',  'listings.manage'),
  ('admin',  'activity-log.view'),
  ('editor', 'listings.manage'),
  ('broker', 'listings.manage_own');

-- Does the signed-in user hold this permission? False without a JWT: the
-- service role is let through by the callers' own `auth.uid() is not null`
-- guards, as before.
create function private.has_permission(p_permission text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select (select private.current_role_rank()) >= 100
      or exists (
           select 1
             from public.user_roles ur
             join public.role_permissions rp on rp.role = ur.role
            where ur.user_id = (select auth.uid())
              and rp.permission = p_permission);
$$;
revoke all on function private.has_permission(text) from public;
grant execute on function private.has_permission(text) to authenticated, service_role;

alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
create policy "Role holders read the permission list" on public.permissions for select to authenticated
  using ((select private.current_role_rank()) > 0);
create policy "Role holders read the matrix" on public.role_permissions for select to authenticated
  using ((select private.current_role_rank()) > 0);
-- Written only by set_role_permissions() below.
revoke all on public.permissions, public.role_permissions from anon, authenticated;
grant select on public.permissions, public.role_permissions to authenticated;
grant select on public.permissions, public.role_permissions to service_role;

-- The signed-in user's permissions, for the screens to decide what to offer.
-- The database checks again whatever they then do.
create function public.my_permissions() returns setof text
  language sql stable security definer set search_path = ''
as $$
  select p.name from public.permissions p where private.has_permission(p.name) order by p.position;
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ---------------------------------------------------------------------------
-- Changing the matrix, and the record of changes
-- ---------------------------------------------------------------------------

create table public.role_permission_events (
  id               bigint generated always as identity primary key,
  role             text not null,
  added            text[] not null,
  removed          text[] not null,
  changed_by       uuid,
  changed_by_email text,
  changed_at       timestamptz not null default now()
);
create index role_permission_events_changed_at on public.role_permission_events (changed_at desc);

alter table public.role_permission_events enable row level security;
create policy "Matrix editors and log readers read the record of permission changes"
  on public.role_permission_events for select to authenticated
  using ((select private.has_permission('roles.manage')) or (select private.has_permission('activity-log.view')));
revoke all on public.role_permission_events from anon, authenticated;
grant select on public.role_permission_events to authenticated, service_role;

create function public.set_role_permissions(p_role text, p_permissions text[]) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_current text[];
  v_wanted  text[] := coalesce(p_permissions, '{}');
  v_added   text[];
  v_removed text[];
begin
  if (select auth.uid()) is not null and not (select private.has_permission('roles.manage')) then
    raise exception 'Changing what a role may do needs the roles.manage permission.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.roles where name = p_role) then
    raise exception 'No such role.' using errcode = 'P0002';
  end if;
  if p_role = 'super_admin'
     or ((select auth.uid()) is not null and private.role_rank(p_role) >= (select private.current_role_rank())) then
    raise exception 'Only roles ranked below your own can be changed.' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_wanted) w where w not in (select name from public.permissions)) then
    raise exception 'Unknown permission.' using errcode = 'P0001';
  end if;

  -- One change to the matrix at a time.
  perform 1 from public.roles where name = p_role for update;

  select coalesce(array_agg(permission), '{}') into v_current from public.role_permissions where role = p_role;
  select coalesce(array_agg(w order by w), '{}') into v_added from unnest(v_wanted) w where w <> all (v_current);
  select coalesce(array_agg(c order by c), '{}') into v_removed from unnest(v_current) c where c <> all (v_wanted);

  if (select auth.uid()) is not null
     and exists (select 1 from unnest(v_added || v_removed) x where not private.has_permission(x)) then
    raise exception 'You can grant or withdraw only permissions you hold yourself.' using errcode = '42501';
  end if;
  if cardinality(v_added) = 0 and cardinality(v_removed) = 0 then
    return;
  end if;

  delete from public.role_permissions where role = p_role and permission = any (v_removed);
  insert into public.role_permissions (role, permission) select p_role, unnest(v_added);
  insert into public.role_permission_events (role, added, removed, changed_by, changed_by_email)
  values (p_role, v_added, v_removed, (select auth.uid()), (select u.email from auth.users u where u.id = (select auth.uid())));
end;
$$;
revoke all on function public.set_role_permissions(text, text[]) from public, anon;
grant execute on function public.set_role_permissions(text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Policies: ranks become permissions
-- ---------------------------------------------------------------------------

alter policy "Users read their own role; admins read every role" on public.user_roles
  using (user_id = (select auth.uid()) or (select private.has_permission('users.manage')));
alter policy "Users read their own role; admins read every role" on public.user_roles
  rename to "Users read their own role; account managers read every role";

alter policy "Super admins can read published key metadata" on public.federation_keys
  using ((select private.has_permission('federation.manage')));
alter policy "Super admins can read published key metadata" on public.federation_keys
  rename to "Federation managers read published key metadata";

alter policy "Super admins manage partners" on public.federation_partners
  using ((select private.has_permission('federation.manage')))
  with check ((select private.has_permission('federation.manage')));
alter policy "Super admins manage partners" on public.federation_partners
  rename to "Federation managers manage partners";

alter policy "Super admins can read the federation request log" on public.federation_request_log
  using ((select private.has_permission('federation.manage')) or (select private.has_permission('activity-log.view')));
alter policy "Super admins can read the federation request log" on public.federation_request_log
  rename to "Federation managers and log readers read the federation request log";

alter policy "Super admins read visibility events" on public.visibility_events
  using ((select private.has_permission('federation.manage')));
alter policy "Super admins read visibility events" on public.visibility_events
  rename to "Federation managers read visibility events";

alter policy "Admins read the record of role changes" on public.user_role_events
  using ((select private.has_permission('users.manage')) or (select private.has_permission('activity-log.view')));
alter policy "Admins read the record of role changes" on public.user_role_events
  rename to "Account managers and log readers read the record of role changes";

-- Vessels and listings. "Own" is listings.manage_own on a listing assigned to
-- the caller; every role holder reads every listing unless their role is
-- limited to their own.
alter policy "Brokers and above add vessels" on public.vessels
  with check ((select private.has_permission('listings.manage')) or (select private.has_permission('listings.manage_own')));
alter policy "Brokers and above add vessels" on public.vessels
  rename to "Listing managers add vessels";

alter policy "Editors and above change vessels; brokers change the vessels of their own listings" on public.vessels
  using (
    (select private.has_permission('listings.manage'))
    or ((select private.has_permission('listings.manage_own'))
        and exists (select 1 from public.listings l where l.vessel_id = vessels.id and l.assigned_broker_id = (select auth.uid()))))
  with check ((select private.has_permission('listings.manage')) or (select private.has_permission('listings.manage_own')));
alter policy "Editors and above change vessels; brokers change the vessels of their own listings" on public.vessels
  rename to "Listing managers change vessels; own-listing managers change the vessels of their own listings";

alter policy "Editors and above delete vessels" on public.vessels
  using ((select private.has_permission('listings.manage')));
alter policy "Editors and above delete vessels" on public.vessels
  rename to "Listing managers delete vessels";

alter policy "Editors and above read every listing; brokers read their own; viewers read all" on public.listings
  using (
    (select private.current_role_rank()) > 0
    and ((select private.has_permission('listings.manage'))
         or not (select private.has_permission('listings.manage_own'))
         or assigned_broker_id = (select auth.uid())));
alter policy "Editors and above read every listing; brokers read their own; viewers read all" on public.listings
  rename to "Role holders read every listing, unless their role is limited to their own";

alter policy "Editors add any listing; brokers add listings assigned to themselves" on public.listings
  with check (
    (select private.has_permission('listings.manage'))
    or ((select private.has_permission('listings.manage_own')) and assigned_broker_id = (select auth.uid())));
alter policy "Editors add any listing; brokers add listings assigned to themselves" on public.listings
  rename to "Listing managers add any listing; own-listing managers add listings assigned to themselves";

alter policy "Editors change any listing; brokers change their own and cannot reassign them" on public.listings
  using (
    (select private.has_permission('listings.manage'))
    or ((select private.has_permission('listings.manage_own')) and assigned_broker_id = (select auth.uid())))
  with check (
    (select private.has_permission('listings.manage'))
    or ((select private.has_permission('listings.manage_own')) and assigned_broker_id = (select auth.uid())));
alter policy "Editors change any listing; brokers change their own and cannot reassign them" on public.listings
  rename to "Listing managers change any listing; own-listing managers change their own and cannot reassign them";

alter policy "Editors and above delete drafts" on public.listings
  using ((select private.has_permission('listings.manage')) and status = 'draft');
alter policy "Editors and above delete drafts" on public.listings
  rename to "Listing managers delete drafts";

alter policy "Whoever may change a listing reads its files back" on storage.objects
  using (bucket_id in ('listing-media', 'listing-originals', 'listing-uploads')
         and (private.can_change_listing_files(name) or (select private.has_permission('listings.manage'))));
alter policy "Whoever may change a listing removes its files" on storage.objects
  using (bucket_id in ('listing-media', 'listing-originals', 'listing-uploads')
         and (private.can_change_listing_files(name) or (select private.has_permission('listings.manage'))));

-- ---------------------------------------------------------------------------
-- Functions: the same bodies, the ranks replaced by permissions
-- ---------------------------------------------------------------------------

create or replace function public.list_users()
 returns table(id uuid, email text, role text, created_at timestamp with time zone, invited_at timestamp with time zone, confirmed_at timestamp with time zone, last_sign_in_at timestamp with time zone, manageable boolean)
 language plpgsql
 stable security definer
 set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not (select private.has_permission('users.manage')) then
    raise exception 'Listing users needs the users.manage permission.' using errcode = '42501';
  end if;

  return query
  select u.id,
         u.email::text,
         ur.role,
         u.created_at,
         u.invited_at,
         u.email_confirmed_at,
         u.last_sign_in_at,
         private.can_manage_user(u.id)
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
   order by coalesce(private.role_rank(ur.role), 0) desc, u.email;
end;
$$;

create or replace function private.can_assign_role(p_role text)
 returns boolean
 language sql
 stable security definer
 set search_path = ''
as $$
  select (select private.current_role_rank()) >= 100
      or ((select private.has_permission('users.manage')) and private.role_rank(p_role) < (select private.current_role_rank()));
$$;

create or replace function private.can_change_listing_files(p_object_name text)
 returns boolean
 language sql
 stable security definer
 set search_path = ''
as $$
  select coalesce((
    select (select private.has_permission('listings.manage'))
        or ((select private.has_permission('listings.manage_own')) and l.assigned_broker_id is not distinct from (select auth.uid()))
      from public.listings l
     where l.uuid = case
             when split_part(p_object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then split_part(p_object_name, '/', 1)::uuid
           end), false);
$$;

create or replace function private.can_manage_user(p_user_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path = ''
as $$
  select p_user_id is distinct from (select auth.uid())
     and (select private.has_permission('users.manage'))
     and (
       (select private.current_role_rank()) >= 100
       or coalesce((select private.role_rank(ur.role) from public.user_roles ur where ur.user_id = p_user_id), 0)
          < (select private.current_role_rank())
     );
$$;

create or replace function public.rotate_signing_key(p_key_id text, p_public_key text, p_private_key text, p_emergency boolean, p_note text default null, p_overlap_hours integer default 48)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  -- coalesce: for a caller with no role the comparison is NULL, and `if not NULL` would not raise.
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Rotating the signing key needs the federation.manage permission.' using errcode = '42501';
  end if;
  if p_emergency and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'An emergency rotation needs a note saying what happened.' using errcode = 'P0001';
  end if;
  if p_overlap_hours is null or p_overlap_hours < 1 or p_overlap_hours > 24 * 14 then
    raise exception 'The overlap must be between 1 hour and 14 days.' using errcode = 'P0001';
  end if;

  -- One rotation at a time.
  perform 1 from public.node_settings where id for update;
  if not exists (select 1 from public.node_settings where setup_completed_at is not null) then
    raise exception 'Setup has not been completed.' using errcode = 'P0001';
  end if;

  update public.federation_keys
     set status = 'retiring',
         retired_at = clock_timestamp(),
         overlap_ends_at = clock_timestamp() + make_interval(hours => p_overlap_hours),
         rotation_note = nullif(btrim(coalesce(p_note, '')), '')
   where status = 'active';

  v_secret_id := vault.create_secret(
    p_private_key,
    'openyacht_signing_key_' || p_key_id,
    'OpenYacht Ed25519 private seed (base64) for key ' || p_key_id);
  insert into public.federation_keys (key_id, public_key, private_key_secret_id) values (p_key_id, p_public_key, v_secret_id);

  -- Emergency: no overlap at all, for the key being replaced or for any still
  -- retiring from an earlier rotation. Routine: only overlaps that have run out.
  perform private.revoke_signing_keys(p_emergency);
end;
$$;

create or replace function public.schedule_sync(p_secret text)
 returns smallint
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_row    private.sync_schedule;
  v_minute smallint;
begin
  -- coalesce: for a caller with no role the comparison is NULL, and `if not NULL` would not raise.
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Scheduling synchronisation needs the federation.manage permission.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_secret, '')), '') is null then
    raise exception 'The internal API secret is blank.' using errcode = 'P0001';
  end if;

  -- One registration at a time.
  perform 1 from public.node_settings where id for update;
  if not exists (select 1 from public.node_settings where setup_completed_at is not null) then
    raise exception 'Setup has not been completed.' using errcode = 'P0001';
  end if;

  select * into v_row from private.sync_schedule;
  if found then
    perform vault.update_secret(v_row.secret_id, p_secret);
    update private.sync_schedule set secret_sha256 = sha256(convert_to(p_secret, 'UTF8')), registered_at = now() where id;
    v_minute := v_row.minute;
  else
    v_minute := floor(random() * 60)::smallint;
    insert into private.sync_schedule (minute, secret_id, secret_sha256)
    values (
      v_minute,
      vault.create_secret(p_secret, 'openyacht_internal_api_secret', 'INTERNAL_API_SECRET, sent by the scheduled sync job'),
      sha256(convert_to(p_secret, 'UTF8'))
    );
  end if;

  -- cron.schedule replaces a job of the same name, so registering twice is safe.
  perform cron.schedule('openyacht-sync', v_minute || ' * * * *', 'select private.request_sync()');
  return v_minute;
end;
$$;

create or replace function public.set_listing_sharing(p_listing_id bigint, p_audience text, p_partner_ids bigint[])
 returns integer
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_listing public.listings;
  v_before  bigint[];
  v_changed integer;
begin
  -- SECURITY DEFINER, because the caller may not write events. So the caller's
  -- right to change this listing is established here: listings.manage, or
  -- listings.manage_own for a listing assigned to the caller. The service role has no JWT and is
  -- let through.
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

  insert into public.visibility_events (listing_id, partner_id, visible)
    select p_listing_id, p.id, private.listing_visible_to(v_listing, p)
      from public.federation_partners p
     where private.listing_visible_to(v_listing, p) <> (p.id = any (v_before));
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

create or replace function public.set_partner_field_groups(p_partner_id bigint, p_field_groups text[])
 returns integer
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_partner public.federation_partners;
  v_count   integer;
begin
  -- coalesce: a NULL comparison must refuse, not pass.
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Changing what a partner is granted needs the federation.manage permission.' using errcode = '42501';
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

create or replace function public.shareable_partners()
 returns table(id bigint, node_name text, domain text)
 language sql
 stable security definer
 set search_path = ''
as $$
  select p.id, p.node_name, p.domain
    from public.federation_partners p
   where p.trust_level = 'verified'
     and ((select private.has_permission('listings.manage')) or (select private.has_permission('listings.manage_own')))
   order by p.node_name;
$$;

create or replace function public.sync_schedule_status()
 returns table(minute smallint, job_active boolean, registered_at timestamp with time zone, secret_sha256 text, last_requested_at timestamp with time zone, last_status_code integer, last_error text, last_timed_out boolean)
 language plpgsql
 stable security definer
 set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'The sync schedule needs the federation.manage permission.' using errcode = '42501';
  end if;

  return query
  select sc.minute,
         coalesce((select j.active from cron.job j where j.jobname = 'openyacht-sync'), false),
         sc.registered_at,
         encode(sc.secret_sha256, 'hex'),
         sc.last_requested_at,
         r.status_code,
         r.error_msg,
         r.timed_out
    from private.sync_schedule sc
    left join net._http_response r on r.id = sc.last_request_id;
end;
$$;

create or replace function public.unschedule_sync()
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Stopping scheduled synchronisation needs the federation.manage permission.' using errcode = '42501';
  end if;

  if exists (select 1 from cron.job where jobname = 'openyacht-sync') then
    perform cron.unschedule('openyacht-sync');
  end if;
  delete from private.sync_schedule where id returning secret_id into v_secret_id;
  delete from vault.secrets where id = v_secret_id;
end;
$$;
