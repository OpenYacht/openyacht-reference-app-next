-- User management: administrators give people roles, change them and take
-- them away, and every change is recorded.
--
-- The rules, enforced here rather than in the admin screens:
--   * admins and super admins manage users; nobody else does;
--   * nobody changes or removes their own role (no self-escalation);
--   * only a super admin assigns super_admin;
--   * an admin manages only accounts ranked below their own, and assigns only
--     roles ranked below their own, so an admin cannot demote another admin;
--   * at least one super_admin always exists (the trigger in node_core).
--
-- Accounts themselves live in auth.users and are created and deleted through
-- the Auth admin API. The application calls it only after the database has
-- agreed the caller may manage that account (can_manage_user below).

-- Rank of a role name; 0 for none.
create function private.role_rank(p_role text) returns smallint
  language sql stable security definer set search_path = ''
as $$
  select coalesce((select r.rank from public.roles r where r.name = p_role), 0)::smallint;
$$;

-- May the signed-in user change or remove this account's role, or the account?
create function private.can_manage_user(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select p_user_id is distinct from (select auth.uid())
     and (select private.current_role_rank()) >= 80
     and (
       (select private.current_role_rank()) >= 100
       or coalesce((select private.role_rank(ur.role) from public.user_roles ur where ur.user_id = p_user_id), 0)
          < (select private.current_role_rank())
     );
$$;

-- May the signed-in user give this role to someone else?
create function private.can_assign_role(p_role text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select (select private.current_role_rank()) >= 100
      or ((select private.current_role_rank()) >= 80 and private.role_rank(p_role) < (select private.current_role_rank()));
$$;

revoke all on function private.role_rank(text) from public;
revoke all on function private.can_manage_user(uuid) from public;
revoke all on function private.can_assign_role(text) from public;
grant execute on function private.role_rank(text) to authenticated, service_role;
grant execute on function private.can_manage_user(uuid) to authenticated, service_role;
grant execute on function private.can_assign_role(text) to authenticated, service_role;

-- The write policies node_core left out. On update, USING judges the role the
-- account holds now and WITH CHECK the role it is being given.
create policy "Admins give roles to accounts they manage"
  on public.user_roles for insert to authenticated
  with check (private.can_manage_user(user_id) and private.can_assign_role(role));

create policy "Admins change the roles of accounts they manage"
  on public.user_roles for update to authenticated
  using (private.can_manage_user(user_id))
  with check (user_id is distinct from (select auth.uid()) and private.can_assign_role(role));

create policy "Admins remove the roles of accounts they manage"
  on public.user_roles for delete to authenticated
  using (private.can_manage_user(user_id));

grant insert (user_id, role), update (role), delete on public.user_roles to authenticated;

-- Who assigned a role is stamped, not claimed: a client cannot name someone
-- else. Writes made without a signed-in user (setup, the service role) keep
-- whatever they set.
create function private.stamp_role_assignment() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    new.assigned_by := (select auth.uid());
  end if;
  return new;
end;
$$;

create trigger user_roles_stamp_assignment
  before insert or update of role on public.user_roles
  for each row execute function private.stamp_role_assignment();

-- ---------------------------------------------------------------------------
-- The record of role changes
-- ---------------------------------------------------------------------------
-- Append-only, and deliberately not tied to auth.users by a foreign key: the
-- record of what an account could do must outlive the account. The email is
-- copied for the same reason.

create table public.user_role_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  user_email    text,
  old_role      text,
  new_role      text,
  changed_by    uuid,
  changed_by_email text,
  changed_at    timestamptz not null default now(),
  check (old_role is distinct from new_role)
);

create index user_role_events_changed_at on public.user_role_events (changed_at desc);

alter table public.user_role_events enable row level security;
create policy "Admins read the record of role changes"
  on public.user_role_events for select to authenticated
  using ((select private.current_role_rank()) >= 80);
revoke all on public.user_role_events from anon, authenticated;
grant select on public.user_role_events to authenticated;
grant select on public.user_role_events to service_role;

create function private.record_role_change() returns trigger
  language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id  uuid := coalesce(new.user_id, old.user_id);
  v_old_role text := case when tg_op = 'INSERT' then null else old.role end;
  v_new_role text := case when tg_op = 'DELETE' then null else new.role end;
begin
  if v_old_role is distinct from v_new_role then
    insert into public.user_role_events (user_id, user_email, old_role, new_role, changed_by, changed_by_email)
    values (
      v_user_id,
      (select u.email from auth.users u where u.id = v_user_id),
      v_old_role,
      v_new_role,
      (select auth.uid()),
      (select u.email from auth.users u where u.id = (select auth.uid()))
    );
  end if;
  return null;
end;
$$;

create trigger user_roles_record_change
  after insert or update or delete on public.user_roles
  for each row execute function private.record_role_change();

revoke all on function private.stamp_role_assignment() from public;
revoke all on function private.record_role_change() from public;

-- ---------------------------------------------------------------------------
-- Reading accounts
-- ---------------------------------------------------------------------------
-- auth.users is not exposed to the Data API, and should not be: it holds
-- password hashes. Administrators get this much of it, and `manageable` says
-- which rows their actions will be allowed on, so the screen can offer only
-- those.

create function public.list_users()
  returns table (
    id              uuid,
    email           text,
    role            text,
    created_at      timestamptz,
    invited_at      timestamptz,
    confirmed_at    timestamptz,
    last_sign_in_at timestamptz,
    manageable      boolean
  )
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 80, false) then
    raise exception 'Only an administrator can list users.' using errcode = '42501';
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

-- The check the application makes before it touches an account through the
-- Auth admin API: the same rule the policies apply, asked as the user.
create function public.can_manage_user(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select private.can_manage_user(p_user_id);
$$;

create function public.can_assign_role(p_role text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.roles where name = p_role) and private.can_assign_role(p_role);
$$;

revoke all on function public.list_users() from public, anon;
revoke all on function public.can_manage_user(uuid) from public, anon;
revoke all on function public.can_assign_role(text) from public, anon;
grant execute on function public.list_users() to authenticated, service_role;
grant execute on function public.can_manage_user(uuid) to authenticated;
grant execute on function public.can_assign_role(text) to authenticated;
