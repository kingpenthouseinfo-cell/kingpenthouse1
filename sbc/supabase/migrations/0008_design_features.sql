-- Features from the new editor design: a programme date, YouTube links, an editor-managed photo gallery,
-- and a "note for donors" under the bank details. Safe to run on a database that has 0001-0007.

-- ───────── programme date (optional) ─────────
alter table public.programmes add column programme_date date;

-- ───────── videos: uploaded files OR YouTube links ─────────
alter table public.programme_videos add column kind text not null default 'upload' check (kind in ('upload', 'youtube'));
alter table public.programme_videos add column youtube_id text check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$');
alter table public.programme_videos alter column src drop not null;
alter table public.programme_videos add constraint programme_videos_kind_ok check (
  (kind = 'upload'  and src is not null and youtube_id is null) or
  (kind = 'youtube' and youtube_id is not null and src is null and poster is null));

-- ───────── photo gallery (photos that belong to no programme) ─────────
create table public.gallery_photos (
  id       uuid primary key default gen_random_uuid(),
  position int  not null check (position >= 0),
  src      text not null check (src ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$'),
  unique (position) deferrable initially deferred
);
create table public.gallery_meta (id int primary key check (id = 1), version int not null default 1);
insert into public.gallery_meta (id) values (1);
alter table public.gallery_photos enable row level security;
alter table public.gallery_meta   enable row level security;
create policy gallery_photos_public_read on public.gallery_photos for select to anon, authenticated using (true);
create policy gallery_meta_public_read   on public.gallery_meta   for select to anon, authenticated using (true);
revoke all on public.gallery_photos, public.gallery_meta from public, anon, authenticated;
grant select on public.gallery_photos, public.gallery_meta to anon, authenticated;

-- ───────── public content now carries the date, video kinds and the gallery ─────────
create or replace function public.content_json(p_versions boolean) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'programmes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'position', p.position, 'name', p.name,
          'short_label', p.short_label, 'context', p.context, 'date', p.programme_date,
          'caption', p.caption, 'description', p.description, 'extras', p.extras,
          'images', coalesce((select jsonb_agg(i.src order by i.position)
                              from public.programme_images i where i.programme_id = p.id), '[]'::jsonb),
          'videos', coalesce((select jsonb_agg(jsonb_build_object('kind', v.kind, 'src', v.src, 'poster', v.poster, 'youtube_id', v.youtube_id) order by v.position)
                              from public.programme_videos v where v.programme_id = p.id), '[]'::jsonb)
        ) || case when p_versions then jsonb_build_object('version', p.version) else '{}'::jsonb end
        order by p.position)
      from public.programmes p), '[]'::jsonb),
    'updates', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', u.id, 'title', u.title, 'body', u.body,
          'programme_id', u.programme_id, 'published_at', u.published_at,
          'images', coalesce((select jsonb_agg(i.src order by i.position)
                              from public.update_images i where i.update_id = u.id), '[]'::jsonb)
        ) || case when p_versions then jsonb_build_object('version', u.version) else '{}'::jsonb end
        order by u.published_at desc, u.id)
      from public.updates u where u.removed_at is null), '[]'::jsonb),
    'gallery', coalesce((select jsonb_agg(g.src order by g.position) from public.gallery_photos g), '[]'::jsonb),
    'site', coalesce((select s.data from public.site_info s where s.id = 1), '{}'::jsonb),
    'site_version', (select s.version from public.site_info s where s.id = 1)
  ) || case when p_versions then jsonb_build_object('gallery_version', (select m.version from public.gallery_meta m where m.id = 1)) else '{}'::jsonb end
$$;

drop function public.public_content();
create function public.public_content() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select public.content_json(false) - 'site_version'
$$;

-- ───────── videos: validate uploaded files and YouTube links ─────────
create or replace function public._clean_videos(p_videos jsonb, p_max int) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_out jsonb := '[]'::jsonb; v_item jsonb; v_kind text; v_src text; v_poster text; v_yt text;
begin
  if p_videos is null or jsonb_typeof(p_videos) <> 'array' then return v_out; end if;
  if jsonb_array_length(p_videos) > p_max then
    perform public._invalid('videos', 'Too many videos (the limit is ' || p_max || ').');
  end if;
  for v_item in select * from jsonb_array_elements(p_videos) loop
    v_kind := coalesce(nullif(btrim(v_item ->> 'kind'), ''), case when coalesce(v_item ->> 'youtube_id', '') <> '' then 'youtube' else 'upload' end);
    if v_kind = 'youtube' then
      v_yt := btrim(coalesce(v_item ->> 'youtube_id', ''));
      if v_yt !~ '^[A-Za-z0-9_-]{11}$' then perform public._invalid('videos', 'That does not look like a YouTube link.'); end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'youtube', 'src', null, 'poster', null, 'youtube_id', v_yt));
    else
      v_src := btrim(coalesce(v_item ->> 'src', '')); v_poster := nullif(btrim(coalesce(v_item ->> 'poster', '')), '');
      if v_src !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|mov|webm)$'
         or to_regclass('storage.objects') is null
         or not exists (select 1 from storage.objects o where o.bucket_id = 'videos' and o.name = v_src) then
        perform public._invalid('videos', 'A video did not finish uploading. Please try again.');
      end if;
      if v_poster is not null and (v_poster !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
         or not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = v_poster)) then
        v_poster := null;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'upload', 'src', v_src, 'poster', v_poster, 'youtube_id', null));
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public._same_videos(p_id uuid, p_videos jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_agg(jsonb_build_object('kind', v.kind, 'src', v.src, 'poster', v.poster, 'youtube_id', v.youtube_id) order by v.position)
                     from public.programme_videos v where v.programme_id = p_id), '[]'::jsonb) = p_videos
$$;

-- ───────── the programme saver: now with a date ─────────
drop function public.editor_save_programme(uuid, int, text, text, text, text, text, jsonb, uuid, jsonb);
create function public.editor_save_programme(
  p_id uuid, p_expected_version int, p_name text, p_short_label text, p_context text,
  p_caption text, p_description text, p_images jsonb, p_client_token uuid,
  p_videos jsonb default null, p_date date default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text; v_short text; v_ctx text; v_cap text; v_desc text; v_imgs text[]; v_vids jsonb;
  v_row public.programmes; v_slug text; v_n int := 1; v_base text;
begin
  perform public._assert_editor();
  v_name  := public._text(p_name, 'name', 'Programme name', 1, 80);
  v_short := public._text(p_short_label, 'short_label', 'Short name for the menu', 1, 24);
  v_ctx   := public._text(p_context, 'context', 'Where it happens', 0, 80);
  v_cap   := public._text(p_caption, 'caption', 'Caption under the main photo', 0, 80);
  v_desc  := public._text(p_description, 'description', 'Description', 0, 800);
  v_imgs  := public._clean_images(p_images, 40);
  v_vids  := case when p_videos is null then null else public._clean_videos(p_videos, 8) end;
  if p_date is not null and (p_date < date '1950-01-01' or p_date > date '2100-12-31') then
    perform public._invalid('pdate', 'Please choose a real date.');
  end if;

  if p_id is null then
    if p_client_token is not null then
      select * into v_row from public.programmes where client_token = p_client_token;
      if found then
        return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
      end if;
    end if;
    lock table public.programmes in share row exclusive mode;
    v_base := public._slugify(v_name); v_slug := v_base;
    while exists (select 1 from public.programmes where slug = v_slug) loop
      v_n := v_n + 1; v_slug := v_base || '-' || v_n;
    end loop;
    insert into public.programmes (slug, position, name, short_label, context, caption, description, programme_date, client_token, updated_by)
    values (v_slug, coalesce((select max(position) from public.programmes), -1) + 1,
            v_name, v_short, v_ctx, v_cap, v_desc, p_date, p_client_token, auth.uid())
    returning * into v_row;
  else
    update public.programmes
       set name = v_name, short_label = v_short, context = v_ctx, caption = v_cap, description = v_desc, programme_date = p_date,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = p_id and version = p_expected_version
    returning * into v_row;
    if not found then
      select * into v_row from public.programmes where id = p_id;
      if not found then raise exception 'This programme could not be found.' using errcode = 'PT404'; end if;
      if v_row.name = v_name and v_row.short_label = v_short and v_row.context = v_ctx
         and v_row.caption = v_cap and v_row.description = v_desc
         and v_row.programme_date is not distinct from p_date
         and public._same_images('p', v_row.id, v_imgs)
         and (v_vids is null or public._same_videos(v_row.id, v_vids)) then
        return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
      end if;
      raise exception 'Someone else changed this programme after you opened it.' using errcode = 'PT409';
    end if;
    delete from public.programme_images where programme_id = v_row.id;
  end if;

  insert into public.programme_images (programme_id, position, src)
  select v_row.id, ord - 1, s from unnest(v_imgs) with ordinality as t(s, ord);

  if v_vids is not null then
    delete from public.programme_videos where programme_id = v_row.id;
    insert into public.programme_videos (programme_id, position, kind, src, poster, youtube_id)
    select v_row.id, ord - 1, e ->> 'kind', nullif(e ->> 'src', ''), nullif(e ->> 'poster', ''), nullif(e ->> 'youtube_id', '')
      from jsonb_array_elements(v_vids) with ordinality as t(e, ord);
  end if;
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
end $$;

-- ───────── the gallery saver (its own version, so it never clashes with About/contact/bank saves) ─────────
create function public.editor_save_gallery(p_expected_version int, p_images jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_imgs text[]; v_cur int; v_same boolean;
begin
  perform public._assert_editor();
  v_imgs := public._clean_images(p_images, 200);
  update public.gallery_meta set version = version + 1 where id = 1 and version = p_expected_version returning version into v_cur;
  if not found then
    select version into v_cur from public.gallery_meta where id = 1;
    select coalesce(array_agg(src order by position), '{}') = v_imgs into v_same from public.gallery_photos;
    if v_same then return jsonb_build_object('version', v_cur); end if;           -- already saved (a retry)
    raise exception 'Someone else changed the gallery after you opened it.' using errcode = 'PT409';
  end if;
  delete from public.gallery_photos;
  insert into public.gallery_photos (position, src) select ord - 1, s from unnest(v_imgs) with ordinality as t(s, ord);
  return jsonb_build_object('version', v_cur);
end $$;

-- ───────── bank details: a note for donors ─────────
create or replace function public.editor_save_bank(p_expected_version int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := jsonb_build_object('bank_account_name', 80, 'bank_name', 80, 'bank_branch', 80,
                                         'bank_account_no', 40, 'bank_swift', 20, 'bank_reference', 80, 'bank_note', 300);
  v_clean jsonb := '{}'::jsonb; v_key text; v_val text; v_cur public.site_info;
begin
  perform public._assert_editor();
  if not public.is_owner() then
    raise exception 'Only the owner can change the bank details.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then perform public._invalid('bank', 'Nothing to save.'); end if;
  for v_key in select jsonb_object_keys(p_data) loop
    if not v_allowed ? v_key then perform public._invalid(v_key, 'That setting cannot be changed here.'); end if;
    v_val := public._text(p_data ->> v_key, v_key, v_key, 0, (v_allowed ->> v_key)::int);
    if v_key = 'bank_account_no' and v_val !~ '^[A-Za-z0-9 .\-/]*$' then
      perform public._invalid(v_key, 'The account number can only have letters, numbers, spaces and dashes.');
    end if;
    if v_key = 'bank_swift' then
      v_val := upper(replace(v_val, ' ', ''));
      if v_val !~ '^([A-Z0-9]{8}|[A-Z0-9]{11})?$' then perform public._invalid(v_key, 'A SWIFT code has 8 or 11 letters and numbers.'); end if;
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;
  update public.site_info set data = data || v_clean, version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = 1 and version = p_expected_version returning * into v_cur;
  if not found then
    select * into v_cur from public.site_info where id = 1;
    if v_cur.data @> v_clean then return jsonb_build_object('version', v_cur.version); end if;
    raise exception 'Someone else changed the site information after you opened it.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('version', v_cur.version);
end $$;

-- Permissions: nothing is callable unless granted here.
revoke execute on function public._clean_videos(jsonb, int), public._same_videos(uuid, jsonb), public.content_json(boolean),
  public.public_content(), public.editor_save_gallery(int, jsonb), public.editor_save_bank(int, jsonb),
  public.editor_save_programme(uuid,int,text,text,text,text,text,jsonb,uuid,jsonb,date) from public, anon, authenticated;
grant execute on function public.content_json(boolean), public.public_content() to anon, authenticated;
grant execute on function public.editor_save_gallery(int, jsonb), public.editor_save_bank(int, jsonb),
  public.editor_save_programme(uuid,int,text,text,text,text,text,jsonb,uuid,jsonb,date) to authenticated;
