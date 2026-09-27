-- Push subscriptions, both halves. Spec: api-design.md §Subscriptions;
-- checklist API-10 (authority) and API-11 (consumer).
--
-- Authority: a verified partner registers one HTTPS callback. When something
-- it could see changes, this node POSTs the listing or tombstone there,
-- signed like any federation request, at least once, with exponential
-- backoff for 24 hours. Polling stays the baseline; a push is a hint that
-- arrives sooner.
--
-- Advertising the feature is a setting, off by default: deliveries need a
-- worker that runs every minute, which is a decision about cost, not code.
--
-- Nothing records a change twice. Deliveries come from the two things the
-- polled feed already keys on — a listing's federation_updated_at, and each
-- new visibility event — and the payload is decided when it is sent, by the
-- feed's own per-row decision for that one pair, so a retry after a later
-- edit carries the later state.
--
-- Consumer: this node subscribes to a partner that offers pushes and accepts
-- deliveries at /openyacht/v1/inbox from partners it subscribed to. They are
-- applied like a polled item; polling drops to a daily reconciliation.

alter table public.node_settings add column push_enabled boolean not null default false;

alter table public.federation_partners
  -- Authority side: where this partner asked to be pushed to.
  add column push_callback_url           text check (push_callback_url like 'https://%'),
  add column push_callback_registered_at timestamptz,
  add column push_last_delivered_at      timestamptz,
  add column push_last_failed_at         timestamptz,
  add column push_last_error             text,
  -- Consumer side: when this node subscribed to the partner's pushes.
  add column push_subscribed_at          timestamptz;

-- One waiting delivery per (partner, listing). A burst of edits folds into the
-- waiting row: changed_at moves, the retry slot does not.
create table public.push_deliveries (
  partner_id      bigint not null references public.federation_partners (id) on delete cascade,
  listing_id      bigint not null references public.listings (id) on delete cascade,
  changed_at      timestamptz not null default clock_timestamp(),
  queued_at       timestamptz not null default clock_timestamp(),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error      text,
  primary key (partner_id, listing_id)
);
create index push_deliveries_due_idx on public.push_deliveries (next_attempt_at);
create index push_deliveries_listing_id_idx on public.push_deliveries (listing_id);

alter table public.push_deliveries enable row level security;
create policy "Federation managers read the delivery queue" on public.push_deliveries for select to authenticated
  using ((select private.has_permission('federation.manage')));
revoke all on public.push_deliveries from anon, authenticated;
grant select on public.push_deliveries to authenticated;
grant all on public.push_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- Fan-out
-- ---------------------------------------------------------------------------
-- Queues a delivery to every subscribed, verified partner that can see the
-- listing or has seen it (and so is owed its tombstone) — or, given a
-- partner, to that one. Nothing while pushes are switched off.
create function private.enqueue_push(p_listing_id bigint, p_partner_id bigint default null) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if not coalesce((select push_enabled from public.node_settings), false) then
    return;
  end if;
  insert into public.push_deliveries as d (partner_id, listing_id)
    select p.id, l.id
      from public.listings l
      join public.federation_partners p
        on p.push_callback_url is not null and p.trust_level = 'verified' and (p_partner_id is null or p.id = p_partner_id)
     where l.id = p_listing_id
       and l.status <> 'draft'
       and (private.listing_visible_to(l, p)
            or exists (select 1 from public.visibility_events e where e.listing_id = l.id and e.partner_id = p.id))
  on conflict (partner_id, listing_id) do update set changed_at = clock_timestamp();
end;
$$;

create function private.push_on_visibility_event() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_push(new.listing_id, new.partner_id);
  return null;
end;
$$;

create function private.push_on_listing_change() returns trigger
  language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_push(new.id);
  return null;
end;
$$;

-- AFTER triggers: the state is written before the change is queued, and the
-- delivery itself runs after commit, so it can only ever read applied state.
-- Not `after update of federation_updated_at`: that fires only when a
-- statement names the column, and the stamp is written by a BEFORE trigger.
create trigger visibility_events_push after insert on public.visibility_events
  for each row execute function private.push_on_visibility_event();
create trigger listings_push after update on public.listings
  for each row when (old.federation_updated_at is distinct from new.federation_updated_at)
  execute function private.push_on_listing_change();
-- A listing can also arrive already distributable, with no event and no
-- update: it is visible to everyone at once.
create trigger listings_push_insert after insert on public.listings
  for each row when (new.status <> 'draft')
  execute function private.push_on_listing_change();

revoke all on function private.enqueue_push(bigint, bigint) from public;
revoke all on function private.push_on_visibility_event() from public;
revoke all on function private.push_on_listing_change() from public;

-- The feed's per-row decision for one (partner, listing): the same function
-- the polled feed runs, narrowed to one listing, so a push and a poll can
-- never disagree. No row: the partner has nothing to be told (a draft, or a
-- listing it never saw). Clear rather than fast; a node with a very large
-- inventory would give feed_for_partner a listing filter instead.
create function public.feed_row_for(p_partner_id bigint, p_listing_id bigint)
  returns table (listing_id bigint, listing_uuid uuid, effective_at text, kind text, tombstone_status text, tombstone_at timestamptz)
  language sql stable security definer set search_path = ''
as $$
  select * from public.feed_for_partner(p_partner_id, null, null, null, 2147483647) f where f.listing_id = p_listing_id;
$$;

-- ---------------------------------------------------------------------------
-- The worker's side of the queue
-- ---------------------------------------------------------------------------

-- Takes up to p_limit due deliveries and leases them for ten minutes, so an
-- overlapping run does not send them twice. Deliveries to a partner that is no
-- longer verified, or has withdrawn its callback, are dropped first: a blocked
-- partner stops receiving at once.
create function public.claim_push_deliveries(p_limit integer)
  returns table (partner_id bigint, listing_id bigint, changed_at timestamptz, queued_at timestamptz, attempts integer, callback text, domain text)
  language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.push_deliveries d
   using public.federation_partners p
   where p.id = d.partner_id and (p.push_callback_url is null or p.trust_level <> 'verified');

  return query
  with due as (
    select d.partner_id, d.listing_id
      from public.push_deliveries d
     where d.next_attempt_at <= clock_timestamp()
     order by d.next_attempt_at
     limit p_limit
       for update skip locked
  )
  update public.push_deliveries d
     set next_attempt_at = clock_timestamp() + interval '10 minutes'
    from due, public.federation_partners p
   where d.partner_id = due.partner_id and d.listing_id = due.listing_id and p.id = d.partner_id
  returning d.partner_id, d.listing_id, d.changed_at, d.queued_at, d.attempts, p.push_callback_url, p.domain;
end;
$$;

-- Records what became of one attempt. A success completes the row — unless a
-- change landed while it was in flight, in which case the row is due again at
-- once. A failure backs off, 60 s doubling to a 4-hour cap, and is abandoned
-- 24 hours after it was queued (API-10); the next poll reconciles.
create function public.finish_push_delivery(
  p_partner_id bigint, p_listing_id bigint, p_claimed_changed_at timestamptz, p_delivered boolean, p_error text default null
) returns text
  language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.push_deliveries;
begin
  select * into v_row from public.push_deliveries where partner_id = p_partner_id and listing_id = p_listing_id for update;
  if not found then
    return 'gone';
  end if;

  if p_delivered then
    update public.federation_partners set push_last_delivered_at = now() where id = p_partner_id;
    if v_row.changed_at = p_claimed_changed_at then
      delete from public.push_deliveries where partner_id = p_partner_id and listing_id = p_listing_id;
      return 'delivered';
    end if;
    update public.push_deliveries set attempts = 0, next_attempt_at = clock_timestamp(), last_error = null
     where partner_id = p_partner_id and listing_id = p_listing_id;
    return 'changed';
  end if;

  update public.federation_partners set push_last_failed_at = now(), push_last_error = left(p_error, 500) where id = p_partner_id;
  if v_row.queued_at < clock_timestamp() - interval '24 hours' then
    delete from public.push_deliveries where partner_id = p_partner_id and listing_id = p_listing_id;
    return 'abandoned';
  end if;
  update public.push_deliveries
     set attempts = v_row.attempts + 1,
         next_attempt_at = clock_timestamp() + least(interval '60 seconds' * power(2, v_row.attempts), interval '4 hours'),
         last_error = left(p_error, 500)
   where partner_id = p_partner_id and listing_id = p_listing_id;
  return 'retrying';
end;
$$;

revoke all on function public.feed_row_for(bigint, bigint) from public, anon, authenticated;
revoke all on function public.claim_push_deliveries(integer) from public, anon, authenticated;
revoke all on function public.finish_push_delivery(bigint, bigint, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.feed_row_for(bigint, bigint) to service_role;
grant execute on function public.claim_push_deliveries(integer) to service_role;
grant execute on function public.finish_push_delivery(bigint, bigint, timestamptz, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- The delivery job
-- ---------------------------------------------------------------------------
-- Every minute while pushes are on, pg_cron calls POST /api/internal/push —
-- but only when something is due, so an idle node makes no requests. It uses
-- the secret the sync schedule already holds in Vault.
create function private.request_push() returns bigint
  language plpgsql security definer set search_path = ''
as $$
declare
  v_domain text;
  v_secret text;
begin
  if not exists (select 1 from public.push_deliveries where next_attempt_at <= clock_timestamp()) then
    return null;
  end if;
  select n.identity_domain into v_domain from public.node_settings n where n.setup_completed_at is not null;
  select s.decrypted_secret into v_secret from private.sync_schedule sc join vault.decrypted_secrets s on s.id = sc.secret_id;
  if v_domain is null or v_secret is null then
    return null;
  end if;
  return net.http_post(
    url := 'https://' || v_domain || '/api/internal/push',
    headers := jsonb_build_object('authorization', 'Bearer ' || v_secret, 'content-type', 'application/json'),
    timeout_milliseconds := 300000
  );
end;
$$;
revoke all on function private.request_push() from public;

-- Switches pushes on or off. On needs the sync schedule, whose secret the job
-- uses. Off stops advertising, stops queueing and drops what was waiting; the
-- partners' registrations stay, and resume when it is switched on again.
create function public.set_push_enabled(p_enabled boolean) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not (select private.has_permission('federation.manage')) then
    raise exception 'Push subscriptions need the federation.manage permission.' using errcode = '42501';
  end if;
  if p_enabled and not exists (select 1 from private.sync_schedule) then
    raise exception 'Schedule hourly sync first: the delivery job uses its secret.' using errcode = 'P0001';
  end if;

  update public.node_settings set push_enabled = p_enabled where id;
  if p_enabled then
    perform cron.schedule('openyacht-push', '* * * * *', 'select private.request_push()');
  else
    if exists (select 1 from cron.job where jobname = 'openyacht-push') then
      perform cron.unschedule('openyacht-push');
    end if;
    delete from public.push_deliveries where true;
  end if;
end;
$$;
revoke all on function public.set_push_enabled(boolean) from public, anon;
grant execute on function public.set_push_enabled(boolean) to authenticated, service_role;

-- Stopping the sync schedule takes the push job with it: it has no secret left.
create or replace function public.unschedule_sync() returns void
  language plpgsql security definer set search_path = ''
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
  if (select push_enabled from public.node_settings) then
    perform public.set_push_enabled(false);
  end if;
  delete from private.sync_schedule where id returning secret_id into v_secret_id;
  delete from vault.secrets where id = v_secret_id;
end;
$$;
