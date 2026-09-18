-- Node core: roles, node identity state, and federation keys.
--
-- Two trust domains meet in this database and stay visibly separate:
--   * the admin UI reads as the signed-in user, under row level security;
--   * federation handlers and the setup wizard use the service role, which
--     bypasses RLS. A federation partner is authenticated by request
--     signature, never by a Supabase JWT.

-- Helper functions live in a schema the REST API does not expose.
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Seeded here, in the migration, so that a fresh database can always hold its
-- first administrator: an install path that needs a separate seeding step is
-- an install path that fails on a cold clone.

create table public.roles (
  name        text primary key,
  rank        smallint not null unique,
  description text not null
);

insert into public.roles (name, rank, description) values
  ('super_admin', 100, 'Everything, including federation configuration and keys.'),
  ('admin',        80, 'Listing and user management, general settings; no federation configuration.'),
  ('editor',       60, 'All listings, media and contacts.'),
  ('broker',       40, 'Own listings and own client contacts only.'),
  ('viewer',       20, 'Read-only.');

create table public.user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null references public.roles (name),
  assigned_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Rank of the signed-in user; 0 for a user who holds no role. SECURITY DEFINER
-- so that policies on user_roles can consult user_roles without recursing
-- into themselves.
create function private.current_role_rank() returns smallint
  language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select r.rank
       from public.user_roles ur
       join public.roles r on r.name = ur.role
      where ur.user_id = (select auth.uid())),
    0)::smallint;
$$;
revoke all on function private.current_role_rank() from public;
grant execute on function private.current_role_rank() to authenticated, service_role;

-- At least one super_admin always exists. A trigger rather than a policy, so
-- the rule also binds the service role and cascading deletes of auth users.
create function private.protect_last_super_admin() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'super_admin'
     and (tg_op = 'DELETE' or new.role <> 'super_admin')
     and not exists (
       select 1 from public.user_roles
        where role = 'super_admin' and user_id <> old.user_id)
  then
    raise exception 'At least one super_admin must exist.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_roles_protect_last_super_admin
  before update or delete on public.user_roles
  for each row execute function private.protect_last_super_admin();

alter table public.roles enable row level security;
alter table public.user_roles enable row level security;

create policy "Signed-in users can read the role list"
  on public.roles for select to authenticated
  using (true);

create policy "Users read their own role; admins read every role"
  on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or private.current_role_rank() >= 80);

-- No insert, update or delete policy exists yet, so signed-in users cannot
-- change roles at all: the first role is written by complete_setup() below.
-- When user management is added, its write policies must keep these
-- rules: only a super_admin assigns super_admin, and nobody changes their own
-- role.

-- ---------------------------------------------------------------------------
-- Node state
-- ---------------------------------------------------------------------------
-- One row. The node UUID is generated at installation (FP-5). The identity
-- domain is configured in the environment; the value it had at setup is
-- recorded here so a later change is detected rather than silently forking
-- the node's identity — canonical listing URIs make the domain permanent.

create table public.node_settings (
  id                 boolean primary key default true check (id),
  node_uuid          uuid,
  identity_domain    text,
  identity_mode      text check (identity_mode in ('trial', 'production')),
  setup_completed_at timestamptz,
  created_at         timestamptz not null default now()
);

insert into public.node_settings default values;

alter table public.node_settings enable row level security;

create policy "Role holders can read the node state"
  on public.node_settings for select to authenticated
  using (private.current_role_rank() > 0);

-- ---------------------------------------------------------------------------
-- Federation keys
-- ---------------------------------------------------------------------------
-- Mirrors the spec's reference schema (federation-protocol.md §Keys) with one
-- difference: there is no private_key column. The private seed is held in
-- Supabase Vault, encrypted at rest (FP-4), and this table stores only the
-- Vault secret's id. Nothing a signed-in user can select from here is secret.

create type public.federation_key_status as enum ('active', 'retiring', 'revoked');

create table public.federation_keys (
  id                    bigint generated always as identity primary key,
  key_id                varchar(16) not null unique check (key_id ~ '^[0-9a-f]{16}$'),
  public_key            text not null check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  private_key_secret_id uuid not null,
  status                public.federation_key_status not null default 'active',
  created_at            timestamptz not null default now(),
  retired_at            timestamptz
);

alter table public.federation_keys enable row level security;

create policy "Super admins can read published key metadata"
  on public.federation_keys for select to authenticated
  using (private.current_role_rank() >= 100);

-- Completes first-run setup in one transaction: the first administrator's
-- role, the node UUID, and the first signing key either all exist afterwards
-- or none do. Refuses to run twice.
create function public.complete_setup(
  p_admin_user_id   uuid,
  p_identity_domain text,
  p_identity_mode   text,
  p_node_uuid       uuid,
  p_key_id          text,
  p_public_key      text,
  p_private_key     text
) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  perform 1 from public.node_settings where id for update;
  if exists (select 1 from public.node_settings where setup_completed_at is not null) then
    raise exception 'Setup has already been completed.' using errcode = 'P0001';
  end if;

  v_secret_id := vault.create_secret(
    p_private_key,
    'openyacht_signing_key_' || p_key_id,
    'OpenYacht Ed25519 private seed (base64) for key ' || p_key_id);

  insert into public.federation_keys (key_id, public_key, private_key_secret_id)
  values (p_key_id, p_public_key, v_secret_id);

  insert into public.user_roles (user_id, role)
  values (p_admin_user_id, 'super_admin');

  update public.node_settings
     set node_uuid = p_node_uuid,
         identity_domain = p_identity_domain,
         identity_mode = p_identity_mode,
         setup_completed_at = now()
   where id;
end;
$$;

-- The current signing key with its decrypted private seed. The only path by
-- which the seed leaves Vault, and only the service role may take it.
create function public.active_signing_key()
  returns table (key_id varchar, private_key text)
  language sql stable security definer set search_path = ''
as $$
  select k.key_id, s.decrypted_secret
    from public.federation_keys k
    join vault.decrypted_secrets s on s.id = k.private_key_secret_id
   where k.status = 'active'
   order by k.id desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- Stated here rather than inherited. A Supabase project either grants the API
-- roles everything on new public tables ("Automatically expose new tables") or
-- grants them nothing, depending on a setting chosen when it was created. This
-- migration must produce the same node under both, so it revokes whatever the
-- project handed out and grants exactly what the application uses:
--   * anon — nothing. No page or endpoint reads the database unauthenticated.
--   * authenticated — SELECT only, and then only the rows RLS allows.
--   * service_role — everything; it is the federation and setup trust domain.
revoke all on public.roles, public.user_roles, public.node_settings, public.federation_keys
  from anon, authenticated;
grant select on public.roles, public.user_roles, public.node_settings, public.federation_keys
  to authenticated;
grant all on public.roles, public.user_roles, public.node_settings, public.federation_keys
  to service_role;

-- Supabase's default privileges grant EXECUTE on new public functions to the
-- API roles, so revoking from PUBLIC alone would leave both callable by anyone
-- holding the publishable key.
revoke all on function public.complete_setup(uuid, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.active_signing_key() from public, anon, authenticated;
grant execute on function public.complete_setup(uuid, text, text, uuid, text, text, text) to service_role;
grant execute on function public.active_signing_key() to service_role;
