-- Inbound federation: partnership requests and the request log.

-- ---------------------------------------------------------------------------
-- Partnership requests
-- ---------------------------------------------------------------------------
-- A signed POST /openyacht/v1/partners/request carries a message and a contact
-- address. They are stored on the partner row because that is where the
-- administrator deciding whether to approve will look — a request filed
-- somewhere nobody reads is the same as no request.

alter table public.federation_partners
  add column request_message       text,
  add column request_contact_email text,
  add column requested_at          timestamptz,
  -- Set when the partner record was created by the partner contacting this
  -- node (FP-13), rather than by an administrator here adding it.
  add column first_contact_at      timestamptz;

-- ---------------------------------------------------------------------------
-- Inbound request log
-- ---------------------------------------------------------------------------
-- Every signed request, with who sent it and how verification ended. It is
-- the debugging tool for federation problems and the evidence base for
-- questions about how shared data was used. Signatures are never stored (FP-4).

create table public.federation_request_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  request_id    text not null,
  -- As claimed by X-OpenYacht-Node. Unverified when the outcome says so.
  sender_domain text,
  partner_id    bigint references public.federation_partners (id) on delete set null,
  method        text not null,
  path          text not null,
  -- 'ok', or the error code the request was answered with.
  outcome       text not null,
  http_status   integer not null
);

create index federation_request_log_partner_id_idx on public.federation_request_log (partner_id);
create index federation_request_log_occurred_at_idx on public.federation_request_log (occurred_at desc);

alter table public.federation_request_log enable row level security;

create policy "Super admins can read the federation request log"
  on public.federation_request_log for select to authenticated
  using ((select private.current_role_rank()) >= 100);

-- Written by the federation handlers (service role) only; nobody edits a log.
revoke all on public.federation_request_log from anon, authenticated;
grant select on public.federation_request_log to authenticated;
grant all on public.federation_request_log to service_role;
