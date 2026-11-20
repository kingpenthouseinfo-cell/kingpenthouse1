-- Gallery photos get an optional caption (up to 160 characters). Safe on a database that has 0001-0008.
alter table public.gallery_photos add column caption text not null default '' check (char_length(caption) <= 160);

-- The public gallery is now a list of {src, caption}.
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
    'gallery', coalesce((select jsonb_agg(jsonb_build_object('src', g.src, 'caption', g.caption) order by g.position) from public.gallery_photos g), '[]'::jsonb),
    'site', coalesce((select s.data from public.site_info s where s.id = 1), '{}'::jsonb),
    'site_version', (select s.version from public.site_info s where s.id = 1)
  ) || case when p_versions then jsonb_build_object('gallery_version', (select m.version from public.gallery_meta m where m.id = 1)) else '{}'::jsonb end
$$;

-- Save the whole gallery list: each item is {src, caption} (a plain string still works and means "no caption").
create or replace function public.editor_save_gallery(p_expected_version int, p_images jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_srcs jsonb := '[]'::jsonb; v_caps text[] := '{}'; v_item jsonb; v_cap text; v_clean text[];
  v_cur int; v_same boolean;
begin
  perform public._assert_editor();
  if p_images is null or jsonb_typeof(p_images) <> 'array' then perform public._invalid('photos', 'The photos could not be read.'); end if;
  if jsonb_array_length(p_images) > 200 then perform public._invalid('photos', 'Too many photos (the limit is 200).'); end if;
  for v_item in select * from jsonb_array_elements(p_images) loop
    if jsonb_typeof(v_item) = 'string' then
      v_srcs := v_srcs || jsonb_build_array(v_item #>> '{}'); v_cap := '';
    elsif jsonb_typeof(v_item) = 'object' then
      v_srcs := v_srcs || jsonb_build_array(coalesce(v_item ->> 'src', ''));
      v_cap := public._text(v_item ->> 'caption', 'caption', 'Caption', 0, 160);
    else
      perform public._invalid('photos', 'A photo reference was not valid.');
    end if;
    v_caps := v_caps || v_cap;
  end loop;
  v_clean := public._clean_images(v_srcs, 200);
  update public.gallery_meta set version = version + 1 where id = 1 and version = p_expected_version returning version into v_cur;
  if not found then
    select version into v_cur from public.gallery_meta where id = 1;
    select coalesce(array_agg(src order by position), '{}') = v_clean and coalesce(array_agg(caption order by position), '{}') = v_caps
      into v_same from public.gallery_photos;
    if v_same then return jsonb_build_object('version', v_cur); end if;           -- already saved (a retry)
    raise exception 'Someone else changed the gallery after you opened it.' using errcode = 'PT409';
  end if;
  delete from public.gallery_photos;
  insert into public.gallery_photos (position, src, caption)
  select ord - 1, s, c from unnest(v_clean, v_caps) with ordinality as t(s, c, ord);
  return jsonb_build_object('version', v_cur);
end $$;
