-- Federation alerts: the events the protocol says administrators must be told
-- about, kept until a person has seen them.
--
--   first_contact      FP-13: an unknown node made verified first contact and
--                      is registered as provisional, awaiting approval.
--   node_uuid_changed  FP-11: a known partner's domain now answers with a
--                      different node UUID; the partner is back to provisional.
--
-- Written by the federation handlers (service role). Shown on the dashboard to
-- everyone holding federation.notifications, until one of them dismisses it.
-- The node sends no email: it has no mail provider to rely on.

-- The role descriptions seeded with the roles predate the permission matrix
-- and name features this node does not have. They describe each role's
-- purpose; the matrix says what it may do.
update public.roles set description = 'Every permission, always. Cannot be changed.' where name = 'super_admin';
update public.roles set description = 'Runs the node day to day: accounts below admin, and every listing.' where name = 'admin';
update public.roles set description = 'Every listing and its media.' where name = 'editor';
update public.roles set description = 'The listings assigned to them.' where name = 'broker';
update public.roles set description = 'Reads everything, changes nothing.' where name = 'viewer';

create table public.federation_alerts (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('first_contact', 'node_uuid_changed')),
  partner_id  bigint references public.federation_partners (id) on delete set null,
  -- Kept as text as well: the alert must still say who, if the partner row goes.
  domain      text not null,
  node_name   text,
  detail      jsonb not null default '{}',
  raised_at   timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  -- A resolver only with a time; the time may outlive the resolver's account.
  check (resolved_by is null or resolved_at is not null)
);

create index federation_alerts_open on public.federation_alerts (raised_at desc) where resolved_at is null;
create index federation_alerts_partner_id_idx on public.federation_alerts (partner_id);
create index federation_alerts_resolved_by_idx on public.federation_alerts (resolved_by);

alter table public.federation_alerts enable row level security;
create policy "Alert recipients read alerts" on public.federation_alerts for select to authenticated
  using ((select private.has_permission('federation.notifications')));
-- Raised by the service role only; dismissed through resolve_federation_alert().
revoke all on public.federation_alerts from anon, authenticated;
grant select on public.federation_alerts to authenticated;
grant all on public.federation_alerts to service_role;

create function public.resolve_federation_alert(p_alert_id bigint) returns void
  language plpgsql security definer set search_path = ''
as $$
begin
  if not (select private.has_permission('federation.notifications')) then
    raise exception 'Dismissing an alert needs the federation.notifications permission.' using errcode = '42501';
  end if;
  update public.federation_alerts
     set resolved_at = now(), resolved_by = (select auth.uid())
   where id = p_alert_id and resolved_at is null;
end;
$$;
revoke all on function public.resolve_federation_alert(bigint) from public, anon;
grant execute on function public.resolve_federation_alert(bigint) to authenticated;
