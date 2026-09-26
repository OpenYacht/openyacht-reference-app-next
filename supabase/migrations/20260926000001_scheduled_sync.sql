-- Scheduled sync. Next.js has no scheduler, so the database keeps time:
-- pg_cron fires once an hour and pg_net makes the HTTP call to this node's own
-- POST /api/internal/sync, the route `pnpm sync` calls by hand. Both run inside
-- the Supabase project, so the schedule works the same on every host and plan.
--
-- The job is not created here. It needs INTERNAL_API_SECRET, which belongs to
-- the application's environment, and a migration must not depend on that. A
-- super admin registers it from the dashboard; the secret is then copied into
-- Vault, never into the job's SQL, where cron.job would show it to anyone
-- able to read that table.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- One row while the schedule is registered, none otherwise.
create table private.sync_schedule (
  id                boolean primary key default true check (id),
  -- Chosen at random on first registration and kept after that, so nodes do
  -- not all poll their partners at the top of the hour.
  minute            smallint not null check (minute between 0 and 59),
  secret_id         uuid not null,
  -- Lets the dashboard notice the application's secret has changed since the
  -- schedule was registered, without reading the secret back.
  secret_sha256     bytea not null,
  registered_at     timestamptz not null default now(),
  last_request_id   bigint,
  last_requested_at timestamptz
);

alter table private.sync_schedule enable row level security;
-- No policies and no grants: only the functions below touch it.
revoke all on private.sync_schedule from public, anon, authenticated, service_role;

-- What the job runs: one POST to the sync route on the identity domain, the
-- one hostname guaranteed to reach this application. pg_net queues the request
-- and sends it after this transaction commits; the answer lands in
-- net._http_response, which pg_net keeps for six hours.
create function private.request_sync() returns bigint
  language plpgsql security definer set search_path = ''
as $$
declare
  v_domain     text;
  v_secret     text;
  v_request_id bigint;
begin
  select n.identity_domain into v_domain from public.node_settings n where n.setup_completed_at is not null;
  select s.decrypted_secret into v_secret
    from private.sync_schedule sc
    join vault.decrypted_secrets s on s.id = sc.secret_id;
  if v_domain is null or v_secret is null then
    return null;
  end if;

  v_request_id := net.http_post(
    url := 'https://' || v_domain || '/api/internal/sync',
    headers := jsonb_build_object('authorization', 'Bearer ' || v_secret, 'content-type', 'application/json'),
    -- The route may run for five minutes on a cold sync of a large partner.
    timeout_milliseconds := 300000
  );
  update private.sync_schedule set last_request_id = v_request_id, last_requested_at = clock_timestamp() where id;
  return v_request_id;
end;
$$;

-- Registers the hourly job, or refreshes the secret of one already registered.
-- Super admins only: checked here, because the function runs with its owner's
-- rights, which are what pg_cron and Vault require.
create function public.schedule_sync(p_secret text) returns smallint
  language plpgsql security definer set search_path = ''
as $$
declare
  v_row    private.sync_schedule;
  v_minute smallint;
begin
  -- coalesce: for a caller with no role the comparison is NULL, and `if not NULL` would not raise.
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 100, false) then
    raise exception 'Only a super admin can schedule synchronisation.' using errcode = '42501';
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

-- Removes the job and destroys the stored secret.
create function public.unschedule_sync() returns void
  language plpgsql security definer set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 100, false) then
    raise exception 'Only a super admin can stop scheduled synchronisation.' using errcode = '42501';
  end if;

  if exists (select 1 from cron.job where jobname = 'openyacht-sync') then
    perform cron.unschedule('openyacht-sync');
  end if;
  delete from private.sync_schedule where id returning secret_id into v_secret_id;
  delete from vault.secrets where id = v_secret_id;
end;
$$;

-- What the dashboard shows. No row when nothing is registered. The last
-- request's outcome is null while it is in flight, and again once pg_net has
-- discarded the response.
create function public.sync_schedule_status()
  returns table (
    minute            smallint,
    job_active        boolean,
    registered_at     timestamptz,
    secret_sha256     text,
    last_requested_at timestamptz,
    last_status_code  integer,
    last_error        text,
    last_timed_out    boolean
  )
  language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not coalesce((select private.current_role_rank()) >= 100, false) then
    raise exception 'Only a super admin can see the sync schedule.' using errcode = '42501';
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

revoke all on function private.request_sync() from public;
revoke all on function public.schedule_sync(text) from public, anon;
revoke all on function public.unschedule_sync() from public, anon;
revoke all on function public.sync_schedule_status() from public, anon;
grant execute on function public.schedule_sync(text) to authenticated, service_role;
grant execute on function public.unschedule_sync() to authenticated, service_role;
grant execute on function public.sync_schedule_status() to authenticated, service_role;
