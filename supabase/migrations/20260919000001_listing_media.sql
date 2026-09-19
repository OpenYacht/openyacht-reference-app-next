-- Listing media: where the files live, who may write them, and the functions
-- that change a listing's `media` block. Spec: listing-schema.md §Media,
-- yacht-identity.md §Media identity.

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------
-- listing-media       public. The derived rendition and the thumbnail of every
--                     image, and documents. Served over plain HTTPS from paths
--                     nobody can guess, so a partner's website can embed them.
-- listing-originals   private. Full-resolution images, reached only through
--                     expiring signed URLs, minted for partners granted the
--                     `media_original` field group.
-- listing-uploads     private. Where a browser puts a file before the node has
--                     looked at it. Nothing here is ever served.
--
-- The size limit and the content types are enforced by Storage itself, before
-- the node sees a byte. The first two buckets hold only what the node wrote.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('listing-media',     'listing-media',     true,  26214400, array['image/jpeg', 'application/pdf']),
  ('listing-originals', 'listing-originals', false, 26214400, array['image/jpeg']),
  ('listing-uploads',   'listing-uploads',   false, 26214400, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Who may write a listing's files
-- ---------------------------------------------------------------------------
-- Every object is named <listing uuid>/<item id>/<file>. Whoever may change the
-- listing may write, read back and remove its files: the same rule as the
-- update policy on public.listings, asked by object name. SECURITY DEFINER
-- because a policy on storage.objects cannot rely on the caller's view of
-- public.listings; coalesce because "no such listing" must be false, not NULL.
create function private.can_change_listing_files(p_object_name text) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select (select private.current_role_rank()) >= 60
        or ((select private.current_role_rank()) = 40 and l.assigned_broker_id is not distinct from (select auth.uid()))
      from public.listings l
     where l.uuid = case
             when split_part(p_object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then split_part(p_object_name, '/', 1)::uuid
           end), false);
$$;
revoke all on function private.can_change_listing_files(text) from public;
grant execute on function private.can_change_listing_files(text) to authenticated;

-- No update policy: a file is written once, under a name that is never reused,
-- so the hash a partner was given for a URL stays true for that URL.
create policy "Whoever may change a listing adds its files" on storage.objects for insert to authenticated
  with check (bucket_id in ('listing-media', 'listing-originals', 'listing-uploads') and private.can_change_listing_files(name));
-- Reading back and removing are also open to editors whatever the name says:
-- deleting a draft leaves files whose listing no longer exists, and somebody
-- has to be able to clear them away.
create policy "Whoever may change a listing reads its files back" on storage.objects for select to authenticated
  using (bucket_id in ('listing-media', 'listing-originals', 'listing-uploads')
         and (private.can_change_listing_files(name) or (select private.current_role_rank()) >= 60));
create policy "Whoever may change a listing removes its files" on storage.objects for delete to authenticated
  using (bucket_id in ('listing-media', 'listing-originals', 'listing-uploads')
         and (private.can_change_listing_files(name) or (select private.current_role_rank()) >= 60));

-- ---------------------------------------------------------------------------
-- Changing a listing's media
-- ---------------------------------------------------------------------------
-- `listings.media` is one JSON document, and uploads finish in parallel: read,
-- modify, write from the application would let the second upload to finish
-- erase the first. Each change therefore happens here, under the row lock.
--
-- SECURITY INVOKER, all of them: they run as the signed-in user, so the update
-- policy on public.listings decides whether the listing is theirs to change,
-- and the listings trigger stamps the wire `updated_at` as for any other edit.
--
-- LS-8 is held here too: a listing with any imagery has a profile image. So
-- gallery and layout images need a profile first, and the profile cannot be
-- removed from under them — only replaced.

create function private.listing_media_for_update(p_listing_id bigint) returns jsonb
  language plpgsql set search_path = ''
as $$
declare
  v_media jsonb;
begin
  select l.media into v_media from public.listings l where l.id = p_listing_id for update;
  if not found then
    raise exception 'No such listing, or it is not yours to change.' using errcode = 'P0001';
  end if;
  return v_media;
end;
$$;

create function private.listing_has_imagery(p_media jsonb) returns boolean
  language sql immutable set search_path = ''
as $$
  select jsonb_array_length(coalesce(p_media -> 'gallery', '[]')) + jsonb_array_length(coalesce(p_media -> 'layouts', '[]')) > 0;
$$;

-- Adds an item; `profile` replaces the one there. Returns what was replaced, so
-- that the caller can remove its files, or NULL.
create function public.add_listing_media(p_listing_id bigint, p_collection text, p_item jsonb) returns jsonb
  language plpgsql set search_path = ''
as $$
declare
  v_media jsonb := private.listing_media_for_update(p_listing_id);
  v_replaced jsonb;
  v_sort integer;
begin
  if p_item ->> 'id' is null then
    raise exception 'A media item needs an id.' using errcode = 'P0001';
  end if;

  if p_collection = 'profile' then
    v_replaced := nullif(v_media -> 'profile', 'null');
    v_media := jsonb_set(v_media, '{profile}', p_item);
  elsif p_collection in ('gallery', 'layouts', 'videos', 'tours', 'documents') then
    if p_collection in ('gallery', 'layouts') and nullif(v_media -> 'profile', 'null') is null then
      raise exception 'Choose the profile image first: a listing with any imagery must have one (LS-8).' using errcode = 'P0001';
    end if;
    select coalesce(max((item ->> 'sort')::integer), 0) + 1 into v_sort from jsonb_array_elements(coalesce(v_media -> p_collection, '[]')) item;
    v_media := jsonb_set(v_media, array[p_collection], coalesce(v_media -> p_collection, '[]') || jsonb_build_array(p_item || jsonb_build_object('sort', v_sort)));
  else
    raise exception 'Unknown media collection: %.', p_collection using errcode = 'P0001';
  end if;

  update public.listings set media = v_media where id = p_listing_id;
  return v_replaced;
end;
$$;

-- Removes an item and returns it, so that the caller can remove its files.
create function public.remove_listing_media(p_listing_id bigint, p_collection text, p_item_id text) returns jsonb
  language plpgsql set search_path = ''
as $$
declare
  v_media jsonb := private.listing_media_for_update(p_listing_id);
  v_removed jsonb;
begin
  if p_collection = 'profile' then
    v_removed := nullif(v_media -> 'profile', 'null');
    if v_removed ->> 'id' is distinct from p_item_id then
      return null;
    end if;
    if private.listing_has_imagery(v_media) then
      raise exception 'Upload a new profile image to replace this one. A listing with gallery or layout images must have a profile image (LS-8).'
        using errcode = 'P0001';
    end if;
    v_media := jsonb_set(v_media, '{profile}', 'null');
  elsif p_collection in ('gallery', 'layouts', 'videos', 'tours', 'documents') then
    select item into v_removed from jsonb_array_elements(coalesce(v_media -> p_collection, '[]')) item where item ->> 'id' = p_item_id;
    if v_removed is null then
      return null;
    end if;
    v_media := jsonb_set(v_media, array[p_collection], coalesce(
      (select jsonb_agg(item order by (item ->> 'sort')::integer)
         from jsonb_array_elements(v_media -> p_collection) item
        where item ->> 'id' <> p_item_id), '[]'));
  else
    raise exception 'Unknown media collection: %.', p_collection using errcode = 'P0001';
  end if;

  update public.listings set media = v_media where id = p_listing_id;
  return v_removed;
end;
$$;

-- Caption and gallery category: the two things about an item that can change
-- without the file changing.
create function public.describe_listing_media(p_listing_id bigint, p_collection text, p_item_id text, p_caption text, p_category text) returns void
  language plpgsql set search_path = ''
as $$
declare
  v_media jsonb := private.listing_media_for_update(p_listing_id);
  v_patch jsonb := jsonb_build_object('caption', nullif(btrim(coalesce(p_caption, '')), ''));
begin
  if p_collection = 'gallery' then
    if p_category is not null and p_category not in ('exterior', 'interior', 'lifestyle', 'crew') then
      raise exception 'Unknown gallery category: %.', p_category using errcode = 'P0001';
    end if;
    v_patch := v_patch || jsonb_build_object('category', p_category);
  end if;

  if p_collection = 'profile' then
    if v_media -> 'profile' ->> 'id' is distinct from p_item_id then
      return;
    end if;
    v_media := jsonb_set(v_media, '{profile}', (v_media -> 'profile') || v_patch);
  elsif p_collection in ('gallery', 'layouts', 'videos', 'tours', 'documents') then
    v_media := jsonb_set(v_media, array[p_collection], coalesce(
      (select jsonb_agg(case when item ->> 'id' = p_item_id then item || v_patch else item end order by (item ->> 'sort')::integer)
         from jsonb_array_elements(coalesce(v_media -> p_collection, '[]')) item), '[]'));
  else
    raise exception 'Unknown media collection: %.', p_collection using errcode = 'P0001';
  end if;

  update public.listings set media = v_media where id = p_listing_id;
end;
$$;

-- Moves an item one place earlier (-1) or later (+1) by exchanging `sort`
-- with its neighbour. Order within a collection is `sort`, nothing else.
create function public.move_listing_media(p_listing_id bigint, p_collection text, p_item_id text, p_direction integer) returns void
  language plpgsql set search_path = ''
as $$
declare
  v_media jsonb := private.listing_media_for_update(p_listing_id);
  v_ids text[];
  v_at integer;
  v_other integer;
begin
  if p_collection not in ('gallery', 'layouts', 'videos', 'tours', 'documents') or p_direction not in (-1, 1) then
    raise exception 'Nothing to move.' using errcode = 'P0001';
  end if;
  select array_agg(item ->> 'id' order by (item ->> 'sort')::integer) into v_ids from jsonb_array_elements(coalesce(v_media -> p_collection, '[]')) item;
  v_at := array_position(v_ids, p_item_id);
  v_other := v_at + p_direction;
  if v_at is null or v_other < 1 or v_other > cardinality(v_ids) then
    return;
  end if;
  v_ids[v_at] := v_ids[v_other];
  v_ids[v_other] := p_item_id;

  -- Renumbered from 1 while at it, so gaps left by removals do not accumulate.
  v_media := jsonb_set(v_media, array[p_collection],
    (select jsonb_agg(item || jsonb_build_object('sort', array_position(v_ids, item ->> 'id')) order by array_position(v_ids, item ->> 'id'))
       from jsonb_array_elements(v_media -> p_collection) item));
  update public.listings set media = v_media where id = p_listing_id;
end;
$$;

revoke all on function private.listing_media_for_update(bigint), private.listing_has_imagery(jsonb) from public;
grant execute on function private.listing_media_for_update(bigint), private.listing_has_imagery(jsonb) to authenticated, service_role;

revoke all on function
  public.add_listing_media(bigint, text, jsonb),
  public.remove_listing_media(bigint, text, text),
  public.describe_listing_media(bigint, text, text, text, text),
  public.move_listing_media(bigint, text, text, integer)
from public, anon;
grant execute on function
  public.add_listing_media(bigint, text, jsonb),
  public.remove_listing_media(bigint, text, text),
  public.describe_listing_media(bigint, text, text, text, text),
  public.move_listing_media(bigint, text, text, integer)
to authenticated, service_role;
