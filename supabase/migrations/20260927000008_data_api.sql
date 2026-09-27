-- The data API: this node's displayable yachts — its own listings and the
-- partner listings it displays — for its own websites and feeds, in the
-- protocol's wire shape. Distinct from federation: federation is node to node,
-- authenticated by signature; this is application to consumer, authenticated
-- by API key, with scopes and a per-key rate limit.
--
-- Keys are stored as SHA-256 digests only. A key is 32 random bytes, so a fast
-- digest is enough: there is no low-entropy secret here for a slow hash to
-- protect. The plaintext is shown once, when the key is made.

insert into public.permissions (name, description, position) values
  ('api-keys.manage', 'Create and revoke keys for the data API.', 8);
insert into public.role_permissions (role, permission) values ('admin', 'api-keys.manage');

create table public.api_keys (
  id              bigint generated always as identity primary key,
  name            text not null check (btrim(name) <> ''),
  -- The first characters of the key, to tell keys apart on screen.
  prefix          text not null,
  key_hash        text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes          text[] not null default '{yachts:read}',
  rate_per_minute integer not null default 60 check (rate_per_minute between 1 and 10000),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  -- The rate-limit bucket, one row per key, updated in the same statement as the check.
  tokens          double precision,
  refilled_at     timestamptz
);
create index api_keys_created_by_idx on public.api_keys (created_by);

alter table public.api_keys enable row level security;
create policy "Key managers read keys" on public.api_keys for select to authenticated
  using ((select private.has_permission('api-keys.manage')));
-- Created and revoked only through the functions below. The hash column is
-- readable by key managers; it is not the key.
revoke all on public.api_keys from anon, authenticated;
grant select (id, name, prefix, scopes, rate_per_minute, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant all on public.api_keys to service_role;

create function public.create_api_key(p_name text, p_prefix text, p_key_hash text, p_rate_per_minute integer default 60) returns bigint
  language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  if (select auth.uid()) is not null and not (select private.has_permission('api-keys.manage')) then
    raise exception 'Creating an API key needs the api-keys.manage permission.' using errcode = '42501';
  end if;
  insert into public.api_keys (name, prefix, key_hash, rate_per_minute, created_by)
  values (btrim(p_name), p_prefix, p_key_hash, p_rate_per_minute, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$$;

create function public.revoke_api_key(p_key_id bigint) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not (select private.has_permission('api-keys.manage')) then
    raise exception 'Revoking an API key needs the api-keys.manage permission.' using errcode = '42501';
  end if;
  update public.api_keys set revoked_at = now() where id = p_key_id and revoked_at is null;
  if not found then
    raise exception 'No such active key.' using errcode = 'P0002';
  end if;
end;
$$;

-- Authenticates a request and takes one token from the key's bucket, in one
-- statement, so concurrent requests on one key queue on its row. Returns no
-- row for an unknown or revoked key; otherwise the key's scopes and 0, or the
-- seconds to wait. A refused request costs no token.
create function public.use_api_key(p_key_hash text) returns table (key_id bigint, scopes text[], retry_after integer)
  language plpgsql security definer set search_path = ''
as $$
declare
  v_key    public.api_keys;
  v_now    timestamptz := clock_timestamp();
  v_tokens double precision;
begin
  select * into v_key from public.api_keys k where k.key_hash = p_key_hash and k.revoked_at is null for update;
  if not found then
    return;
  end if;

  v_tokens := least(
    v_key.rate_per_minute,
    coalesce(v_key.tokens, v_key.rate_per_minute)
      + greatest(0, extract(epoch from v_now - coalesce(v_key.refilled_at, v_now))) * v_key.rate_per_minute / 60.0);

  if v_tokens >= 1 then
    update public.api_keys set tokens = v_tokens - 1, refilled_at = v_now, last_used_at = v_now where id = v_key.id;
    return query select v_key.id, v_key.scopes, 0;
  else
    update public.api_keys set tokens = v_tokens, refilled_at = v_now where id = v_key.id;
    return query select v_key.id, v_key.scopes, greatest(1, ceil((1 - v_tokens) * 60 / v_key.rate_per_minute))::integer;
  end if;
end;
$$;

revoke all on function public.create_api_key(text, text, text, integer) from public, anon;
revoke all on function public.revoke_api_key(bigint) from public, anon;
revoke all on function public.use_api_key(text) from public, anon, authenticated;
grant execute on function public.create_api_key(text, text, text, integer) to authenticated;
grant execute on function public.revoke_api_key(bigint) to authenticated;
grant execute on function public.use_api_key(text) to service_role;
