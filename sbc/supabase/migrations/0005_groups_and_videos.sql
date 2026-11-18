-- 1) "Who carries the work out": any number of groups, each with a name, a few words and an optional photo.
-- 2) Programme videos.
-- Safe to run on a database that already has 0001-0004.

-- ───────── Groups: stored as a list inside site_info.data -> 'partners' ─────────
-- Older databases kept exactly three groups as partner1_title / partner1_text … Turn those into the list.
update public.site_info s
   set data = (s.data - array['partner1_title','partner1_text','partner2_title','partner2_text','partner3_title','partner3_text'])
              || jsonb_build_object('partners', coalesce((
                   select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'title', t.title, 'text', coalesce(t.txt, ''), 'image', '') order by t.n)
                     from (select n, s.data ->> ('partner' || n || '_title') as title, s.data ->> ('partner' || n || '_text') as txt
                             from generate_series(1, 3) n) t
                    where coalesce(t.title, '') <> ''), '[]'::jsonb))
 where s.id = 1 and not (s.data ? 'partners');

-- ───────── Videos ─────────
create table public.programme_videos (
  id           uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  position     int  not null check (position >= 0),
  src          text not null check (src ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|mov|webm)$'),   -- file in the "videos" bucket
  poster       text check (poster is null or poster ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),  -- still picture in the "media" bucket
  unique (programme_id, position) deferrable initially deferred
);
alter table public.programme_videos enable row level security;
create policy programme_videos_public_read on public.programme_videos for select to anon, authenticated using (true);
revoke all on public.programme_videos from public, anon, authenticated;
grant select on public.programme_videos to anon, authenticated;

-- Public content now includes each programme's videos.
create or replace function public.content_json(p_versions boolean) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'programmes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'position', p.position, 'name', p.name,
          'short_label', p.short_label, 'context', p.context,
          'caption', p.caption, 'description', p.description, 'extras', p.extras,
          'images', coalesce((select jsonb_agg(i.src order by i.position)
                              from public.programme_images i where i.programme_id = p.id), '[]'::jsonb),
          'videos', coalesce((select jsonb_agg(jsonb_build_object('src', v.src, 'poster', v.poster) order by v.position)
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
    'site', coalesce((select s.data from public.site_info s where s.id = 1), '{}'::jsonb),
    'site_version', (select s.version from public.site_info s where s.id = 1)
  )
$$;

-- Videos must really exist in storage (and their poster picture, if any).
create function public._clean_videos(p_videos jsonb, p_max int) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_out jsonb := '[]'::jsonb; v_item jsonb; v_src text; v_poster text;
begin
  if p_videos is null or jsonb_typeof(p_videos) <> 'array' then return v_out; end if;
  if jsonb_array_length(p_videos) > p_max then
    perform public._invalid('videos', 'Too many videos (the limit is ' || p_max || ').');
  end if;
  for v_item in select * from jsonb_array_elements(p_videos) loop
    v_src := btrim(coalesce(v_item ->> 'src', '')); v_poster := nullif(btrim(coalesce(v_item ->> 'poster', '')), '');
    if v_src !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(mp4|mov|webm)$'
       or to_regclass('storage.objects') is null
       or not exists (select 1 from storage.objects o where o.bucket_id = 'videos' and o.name = v_src) then
      perform public._invalid('videos', 'A video did not finish uploading. Please try again.');
    end if;
    if v_poster is not null and (v_poster !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
       or not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = v_poster)) then
      v_poster := null;     -- a missing still picture is not worth failing the save for
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('src', v_src, 'poster', v_poster));
  end loop;
  return v_out;
end $$;

create function public._same_videos(p_id uuid, p_videos jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_agg(jsonb_build_object('src', v.src, 'poster', v.poster) order by v.position)
                     from public.programme_videos v where v.programme_id = p_id), '[]'::jsonb) = p_videos
$$;

-- The programme saver now also takes videos. p_videos = null leaves the videos as they are.
drop function public.editor_save_programme(uuid, int, text, text, text, text, text, jsonb, uuid);
create function public.editor_save_programme(
  p_id uuid, p_expected_version int, p_name text, p_short_label text, p_context text,
  p_caption text, p_description text, p_images jsonb, p_client_token uuid, p_videos jsonb default null
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
    insert into public.programmes (slug, position, name, short_label, context, caption, description, client_token, updated_by)
    values (v_slug, coalesce((select max(position) from public.programmes), -1) + 1,
            v_name, v_short, v_ctx, v_cap, v_desc, p_client_token, auth.uid())
    returning * into v_row;
  else
    update public.programmes
       set name = v_name, short_label = v_short, context = v_ctx, caption = v_cap, description = v_desc,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = p_id and version = p_expected_version
    returning * into v_row;
    if not found then
      select * into v_row from public.programmes where id = p_id;
      if not found then raise exception 'This programme could not be found.' using errcode = 'PT404'; end if;
      if v_row.name = v_name and v_row.short_label = v_short and v_row.context = v_ctx
         and v_row.caption = v_cap and v_row.description = v_desc
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
    insert into public.programme_videos (programme_id, position, src, poster)
    select v_row.id, ord - 1, e ->> 'src', nullif(e ->> 'poster', '')
      from jsonb_array_elements(v_vids) with ordinality as t(e, ord);
  end if;
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
end $$;

-- Site information: the old fixed "partner1…3" keys are replaced by the 'partners' list.
create or replace function public.editor_save_site(p_expected_version int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := jsonb_build_object(
    'about_kicker', 60, 'about_heading', 120, 'about_heading_italic', 120,
    'about_p1', 800, 'about_p2', 800, 'about_p2_italic', 200,
    'contact_email', 120, 'contact_phone', 40, 'contact_address', 240);
  v_clean jsonb := '{}'::jsonb; v_key text; v_val text; v_cur public.site_info;
  v_groups jsonb := '[]'::jsonb; v_g jsonb; v_i int := 0; v_img text; v_ids uuid;
begin
  perform public._assert_editor();
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    perform public._invalid('site', 'Nothing to save.');
  end if;
  for v_key in select jsonb_object_keys(p_data) loop
    if v_key = 'partners' then continue; end if;
    if not v_allowed ? v_key then
      perform public._invalid(v_key, 'That setting cannot be changed here.');
    end if;
    v_val := public._text(p_data ->> v_key, v_key, v_key, 0, (v_allowed ->> v_key)::int);
    if v_key = 'contact_email' and v_val <> '' and v_val !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform public._invalid('contact_email', 'That email address does not look right.');
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;

  if p_data ? 'partners' then
    if jsonb_typeof(p_data -> 'partners') <> 'array' then perform public._invalid('partners', 'The groups could not be read.'); end if;
    if jsonb_array_length(p_data -> 'partners') > 12 then perform public._invalid('partners', 'There can be up to 12 groups.'); end if;
    for v_g in select * from jsonb_array_elements(p_data -> 'partners') loop
      v_i := v_i + 1;
      if jsonb_typeof(v_g) <> 'object' then perform public._invalid('partners', 'The groups could not be read.'); end if;
      v_ids := case when (v_g ->> 'id') ~ '^[0-9a-f-]{36}$' then (v_g ->> 'id')::uuid else gen_random_uuid() end;
      v_img := coalesce((public._clean_images(case when coalesce(btrim(v_g ->> 'image'), '') = '' then '[]'::jsonb else jsonb_build_array(v_g ->> 'image') end, 1))[1], '');
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'id', v_ids,
        'title', public._text(v_g ->> 'title', 'partners', 'Name of group ' || v_i, 1, 80),
        'text',  public._text(v_g ->> 'text', 'partners', 'What group ' || v_i || ' does', 0, 300),
        'image', v_img));
    end loop;
    v_clean := v_clean || jsonb_build_object('partners', v_groups);
  end if;

  update public.site_info
     set data = data || v_clean, version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = 1 and version = p_expected_version
  returning * into v_cur;
  if not found then
    select * into v_cur from public.site_info where id = 1;
    if v_cur.data @> (v_clean - 'partners')
       and (not v_clean ? 'partners' or v_cur.data -> 'partners' = v_clean -> 'partners') then   -- already saved (a retry)
      return jsonb_build_object('version', v_cur.version);
    end if;
    raise exception 'Someone else changed the site information after you opened it.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('version', v_cur.version);
end $$;

-- Permissions for the functions this file created or replaced.
revoke execute on function public._clean_videos(jsonb, int), public._same_videos(uuid, jsonb),
  public.editor_save_programme(uuid,int,text,text,text,text,text,jsonb,uuid,jsonb),
  public.editor_save_site(int,jsonb), public.content_json(boolean) from public, anon, authenticated;
grant execute on function public.content_json(boolean) to anon, authenticated;
grant execute on function public.editor_save_programme(uuid,int,text,text,text,text,text,jsonb,uuid,jsonb),
  public.editor_save_site(int,jsonb) to authenticated;
