-- Key rotation. Spec: federation-protocol.md §Key Rotation.
--
--   routine     the new key is published alongside the old one and signing moves
--               to it at once; the old key stays published for an overlap
--               period, so a partner holding cached keys never meets a key it
--               cannot find. Then it is revoked.
--   emergency   the old key is revoked there and then. A partner's next
--               verification fails, makes it refetch, and recovers by itself.
--
-- Either way nobody is contacted: identity is the domain, and the keys are
-- whatever the domain serves.

-- When a retiring key stops being published. Publication is decided by this
-- time, not by a job having run: a node with no scheduler still ends its
-- overlap on time.
alter table public.federation_keys add column overlap_ends_at timestamptz;
alter table public.federation_keys
  add constraint federation_keys_retiring_has_an_end check ((status = 'retiring') = (overlap_ends_at is not null));

-- A revoked key's seed is destroyed, so the column that points at it empties.
alter table public.federation_keys alter column private_key_secret_id drop not null;
alter table public.federation_keys
  add constraint federation_keys_revoked_holds_no_seed check ((status = 'revoked') = (private_key_secret_id is null));

-- Why a key was replaced, in the administrator's words. The spec asks for an
-- emergency rotation to be documented; this is where, next to the key itself.
alter table public.federation_keys add column rotation_note text;

-- Exactly one key signs.
create unique index federation_keys_one_active on public.federation_keys ((true)) where status = 'active';

-- Revokes every retiring key whose overlap has ended — or every unrevoked key
-- but the newest, when told to — and destroys their seeds. Internal.
create function private.revoke_signing_keys(p_all_but_active boolean) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_secret_ids uuid[];
begin
  with revoked as (
    update public.federation_keys k
       set status = 'revoked', retired_at = coalesce(k.retired_at, clock_timestamp()), overlap_ends_at = null, private_key_secret_id = null
      from public.federation_keys before
     where before.id = k.id
       and k.status = 'retiring'
       and (p_all_but_active or k.overlap_ends_at <= clock_timestamp())
    returning before.private_key_secret_id
  )
  select array_agg(private_key_secret_id) into v_secret_ids from revoked;

  -- A key that may no longer sign has no reason to exist. After a compromise
  -- it is evidence of nothing and a liability to keep.
  delete from vault.secrets where id = any (coalesce(v_secret_ids, '{}'));
  return coalesce(cardinality(v_secret_ids), 0);
end;
$$;

-- Rotates the signing key. The caller generates the keypair — the database
-- cannot — and the seed goes straight into Vault (FP-4). Super admins only:
-- checked here, because the function runs with its owner's rights.
create function public.rotate_signing_key(
  p_key_id        text,
  p_public_key    text,
  p_private_key   text,
  p_emergency     boolean,
  p_note          text default null,
  p_overlap_hours integer default 48
) returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  -- coalesce: for a caller with no role the comparison is NULL, and `if not NULL` would not raise.
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 100, false) then
    raise exception 'Only a super admin can rotate the signing key.' using errcode = '42501';
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

-- Ends overlaps that have run out. Safe to call at any time and from anywhere
-- a timer reaches; publication does not depend on it (see published_signing_keys).
create function public.expire_retiring_keys() returns integer
  language sql security definer set search_path = ''
as $$
  select private.revoke_signing_keys(false);
$$;

-- What the well-known document publishes: the signing key first, then keys
-- still inside their overlap. Never a revoked key, and never a retiring key
-- past its time, whether or not anything has got round to revoking it.
create function public.published_signing_keys() returns table (key_id varchar, public_key text, created_at timestamptz)
  language sql stable security definer set search_path = ''
as $$
  select k.key_id, k.public_key, k.created_at
    from public.federation_keys k
   where k.status = 'active'
      or (k.status = 'retiring' and k.overlap_ends_at > now())
   order by (k.status = 'active') desc, k.id desc;
$$;

revoke all on function private.revoke_signing_keys(boolean) from public;
revoke all on function public.rotate_signing_key(text, text, text, boolean, text, integer) from public, anon;
revoke all on function public.expire_retiring_keys() from public, anon, authenticated;
revoke all on function public.published_signing_keys() from public, anon, authenticated;
grant execute on function public.rotate_signing_key(text, text, text, boolean, text, integer) to authenticated, service_role;
grant execute on function public.expire_retiring_keys() to service_role;
grant execute on function public.published_signing_keys() to service_role;
