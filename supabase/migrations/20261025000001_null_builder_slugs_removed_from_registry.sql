-- Builders registry 2026.10.0 removed 21 entries that did not identify a
-- single real builder (2026.10.1 restored one more, `blackwater`, which is
-- why it is absent below). A builder slug on the wire is a claim of
-- membership in the vendored registry (LS-11), so a vessel still carrying one
-- of the removed slugs keeps its builder by name and loses the slug: the name
-- is display truth, the slug the interoperability mechanism, and a consumer
-- falls back to the name whenever the slug is null or unknown.
--
-- The `vessels_touch_listings` trigger re-stamps the wire `updated_at` of
-- every listing of an affected vessel, so `updated_since` consumers see the
-- change on their next poll.
update public.vessels
   set builder_slug = null
 where builder_slug in (
   'bluewater', 'ch-marine', 'concept', 'eclipse', 'fishing-raptor', 'grand-alaskan',
   'heritage-east', 'marlago', 'mediterranean', 'northstar', 'parker', 'real',
   'reef-runner', 'saga', 'ses-yachts', 'shearwater', 'strike', 'topaz', 'triton',
   'ultra-lite-tenders', 'vision'
 );
