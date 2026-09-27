-- Subscribing to a partner's pushes is an administrator's action, run as the
-- signed-in user, and this table is granted column by column: the column that
-- records it needs its own grant. Row level security still decides who may.
grant update (push_subscribed_at) on public.federation_partners to authenticated;
