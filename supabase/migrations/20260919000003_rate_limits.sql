-- Per-partner rate limiting. Spec: api-design.md §Rate Limiting.
--
-- The buckets live here rather than in the application's memory because the
-- application may run as many short-lived instances, none of which sees the
-- others' requests. One row per partner; one statement per request.

-- NULL means the node's default. A figure here is this partner's own — the
-- spec's "simply raise the limit" for a partner with a large inventory to
-- fetch. It is both the sustained hourly rate and the size of the burst.
alter table public.federation_partners
  add column rate_per_hour integer check (rate_per_hour between 1 and 1000000);

create table public.federation_rate_limits (
  partner_id  bigint primary key references public.federation_partners (id) on delete cascade,
  tokens      double precision not null,
  refilled_at timestamptz not null
);

alter table public.federation_rate_limits enable row level security;
-- No policies: nothing but the federation handlers reads or writes a bucket.
revoke all on public.federation_rate_limits from anon, authenticated;
grant all on public.federation_rate_limits to service_role;

-- Takes one token from the partner's bucket. Returns 0 when the request may
-- proceed, otherwise the number of seconds until it could. The same
-- arithmetic as takeToken() in federation/rate-limit.ts, in one statement so
-- that concurrent requests from one partner queue on the row and each sees
-- the bucket the last one left.
--
-- A refused request writes nothing but the refill: refusals cost no tokens,
-- so waiting the stated time is always enough.
create function public.take_rate_limit_token(p_domain text, p_default_per_hour integer) returns integer
  language plpgsql security definer set search_path = ''
as $$
declare
  v_partner_id bigint;
  v_per_hour   double precision;
  v_now        timestamptz := clock_timestamp();
  v_tokens     double precision;
begin
  select p.id, coalesce(p.rate_per_hour, p_default_per_hour) into v_partner_id, v_per_hour
    from public.federation_partners p where p.domain = p_domain;
  -- The caller has just verified this partner, so it exists; if it has been
  -- removed in between, there is no bucket to take from and nothing to protect.
  if v_partner_id is null then
    return 0;
  end if;

  insert into public.federation_rate_limits as b (partner_id, tokens, refilled_at)
  values (v_partner_id, v_per_hour, v_now)
  on conflict (partner_id) do update
     set tokens = least(v_per_hour, b.tokens + greatest(0, extract(epoch from v_now - b.refilled_at)) * v_per_hour / 3600),
         refilled_at = v_now
  returning b.tokens into v_tokens;

  if v_tokens >= 1 then
    update public.federation_rate_limits set tokens = v_tokens - 1 where partner_id = v_partner_id;
    return 0;
  end if;
  return greatest(1, ceil((1 - v_tokens) * 3600 / v_per_hour))::integer;
end;
$$;

revoke all on function public.take_rate_limit_token(text, integer) from public, anon, authenticated;
grant execute on function public.take_rate_limit_token(text, integer) to service_role;

-- The partner screen sets the figure. Column by column, as for the rest of
-- this table: see the sharing_admin migration.
grant update (rate_per_hour) on public.federation_partners to authenticated;
