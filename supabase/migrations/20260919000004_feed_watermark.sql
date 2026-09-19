-- The time a feed page says it was generated at.
--
-- Consumers poll with `updated_since`, and the natural value to send next time
-- is the `generated_at` of the last response — the protocol's own reference
-- consumer does exactly that. So `generated_at` is, in effect, a watermark this
-- node hands out, and it has to be safe to use as one: no change may carry a
-- stamp older than a `generated_at` whose response did not include it.
--
-- Two things break that if `generated_at` is simply "now" on the application
-- server:
--   * It is a different clock. Listing stamps come from the database. An
--     application server a few seconds ahead hands out watermarks from the
--     future, and every change made in that gap is skipped by the next poll,
--     permanently.
--   * A change is stamped when it is made and visible when it commits. A page
--     generated in between does not contain it, yet is dated after it.
--
-- So the time comes from the database's clock, and from slightly in the past:
-- far enough that anything stamped earlier has committed. Writes here are
-- single short statements, so a few seconds is generous. The cost is that a
-- partner may be sent again something it received seconds ago, which is
-- harmless — applying a listing twice changes nothing.
create function public.feed_watermark() returns timestamptz
  language sql volatile security definer set search_path = ''
as $$
  select clock_timestamp() - interval '5 seconds';
$$;

revoke all on function public.feed_watermark() from public, anon, authenticated;
grant execute on function public.feed_watermark() to service_role;
