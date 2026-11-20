-- About page "The people on the ground" band:
--   * a scrolling strip of photos with captions
--   * "Faces behind it": priests and sisters, each with a photo, a name and a role
-- plus editable headings for the About page sections. Safe on a database that has 0001-0009.

create table public.about_strip (
  id       uuid primary key default gen_random_uuid(),
  position int  not null check (position >= 0),
  src      text not null check (src ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$'),
  caption  text not null default '' check (char_length(caption) <= 160),
  unique (position) deferrable initially deferred
);
create table public.about_faces (
  id       uuid primary key default gen_random_uuid(),
  position int  not null check (position >= 0),
  src      text not null check (src ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$'),
  name     text not null check (char_length(btrim(name)) between 1 and 80),
  role     text not null default '' check (char_length(role) <= 60),
  focus    text not null default 'center 20%' check (focus ~ '^(center|top|bottom|left|right)( [0-9]{1,3}%)?$'),   -- which part of the photo the round picture shows
  unique (position) deferrable initially deferred
);
-- Each list has its own version number, so editing one never clashes with another.
create table public.about_lists_meta (
  kind    text primary key check (kind in ('strip', 'faces')),
  version int not null default 1,
  seeded  boolean not null default false
);
insert into public.about_lists_meta (kind) values ('strip'), ('faces');

alter table public.about_strip      enable row level security;
alter table public.about_faces      enable row level security;
alter table public.about_lists_meta enable row level security;
create policy about_strip_public_read on public.about_strip      for select to anon, authenticated using (true);
create policy about_faces_public_read on public.about_faces      for select to anon, authenticated using (true);
create policy about_meta_public_read  on public.about_lists_meta for select to anon, authenticated using (true);
revoke all on public.about_strip, public.about_faces, public.about_lists_meta from public, anon, authenticated;
grant select on public.about_strip, public.about_faces, public.about_lists_meta to anon, authenticated;

-- The photos and names the About page already shows. Written once only (never again after editors change them).
do $seed$
begin
  if not (select seeded from public.about_lists_meta where kind = 'strip') then
    insert into public.about_strip (position, src, caption) values
      (0, 'act-team-wall.jpg', 'The parish team, together'),
      (1, 'act-priests-children.jpg', 'Priests at the school handout'),
      (2, 'people-priest-elders.jpg', 'With the elders he visits'),
      (3, 'team-sisters-group.jpg', 'The sisters'),
      (4, 'team-sister-blessing.jpg', 'A blessing at the parish'),
      (5, 'act-sister-envelope.jpg', 'Help handed over, in person'),
      (6, 'act-priest-varod.jpg', 'With VAROD, Vavuniya'),
      (7, 'act-books-handout.jpg', 'Schoolbooks for every child');
    update public.about_lists_meta set seeded = true where kind = 'strip';
  end if;
  if not (select seeded from public.about_lists_meta where kind = 'faces') then
    insert into public.about_faces (position, src, name, role, focus) values
      (0, 'team-01.jpg', 'Fr. —', 'Parish priest', 'center 20%'),
      (1, 'people-sister.jpg', 'Sr. —', 'Religious sister', 'center 18%'),
      (2, 'team-02.jpg', 'Fr. —', 'Parish priest', 'center 14%'),
      (3, 'people-priest-smile.jpg', 'Fr. —', 'Parish priest', 'center 14%'),
      (4, 'team-03.jpg', 'Fr. —', 'Parish priest', 'center 18%'),
      (5, 'people-priest-garden.jpg', 'Fr. —', 'Parish priest', 'center 14%'),
      (6, 'team-04.jpg', 'Fr. —', 'Parish priest', 'center 16%'),
      (7, 'team-05.jpg', 'Fr. —', 'Parish priest', 'center 14%'),
      (8, 'people-sister-priest.jpg', 'Sr. — & Fr. —', 'Sister & priest', 'center 25%');
    update public.about_lists_meta set seeded = true where kind = 'faces';
  end if;
end
$seed$;

-- Public content now carries both lists.
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
    'strip', coalesce((select jsonb_agg(jsonb_build_object('src', s.src, 'caption', s.caption) order by s.position) from public.about_strip s), '[]'::jsonb),
    'faces', coalesce((select jsonb_agg(jsonb_build_object('src', f.src, 'name', f.name, 'role', f.role, 'focus', f.focus) order by f.position) from public.about_faces f), '[]'::jsonb),
    'site', coalesce((select s.data from public.site_info s where s.id = 1), '{}'::jsonb),
    'site_version', (select s.version from public.site_info s where s.id = 1)
  ) || case when p_versions then jsonb_build_object(
         'gallery_version', (select m.version from public.gallery_meta m where m.id = 1),
         'strip_version', (select m.version from public.about_lists_meta m where m.kind = 'strip'),
         'faces_version', (select m.version from public.about_lists_meta m where m.kind = 'faces')) else '{}'::jsonb end
$$;

-- Save the whole scrolling photo strip: items are {src, caption}.
create function public.editor_save_strip(p_expected_version int, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_srcs jsonb := '[]'::jsonb; v_caps text[] := '{}'; v_item jsonb; v_clean text[]; v_cur int; v_same boolean;
begin
  perform public._assert_editor();
  if p_items is null or jsonb_typeof(p_items) <> 'array' then perform public._invalid('photos', 'The photos could not be read.'); end if;
  if jsonb_array_length(p_items) > 40 then perform public._invalid('photos', 'The photo strip can hold up to 40 photos.'); end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then perform public._invalid('photos', 'A photo reference was not valid.'); end if;
    v_srcs := v_srcs || jsonb_build_array(coalesce(v_item ->> 'src', ''));
    v_caps := v_caps || public._text(v_item ->> 'caption', 'caption', 'Caption', 0, 160);
  end loop;
  v_clean := public._clean_images(v_srcs, 40);
  update public.about_lists_meta set version = version + 1 where kind = 'strip' and version = p_expected_version returning version into v_cur;
  if not found then
    select version into v_cur from public.about_lists_meta where kind = 'strip';
    select coalesce(array_agg(src order by position), '{}') = v_clean and coalesce(array_agg(caption order by position), '{}') = v_caps
      into v_same from public.about_strip;
    if v_same then return jsonb_build_object('version', v_cur); end if;           -- already saved (a retry)
    raise exception 'Someone else changed the photo strip after you opened it.' using errcode = 'PT409';
  end if;
  delete from public.about_strip;
  insert into public.about_strip (position, src, caption) select ord - 1, s, c from unnest(v_clean, v_caps) with ordinality as t(s, c, ord);
  return jsonb_build_object('version', v_cur);
end $$;

-- Save the whole list of priests and sisters: items are {src, name, role, focus}.
create function public.editor_save_faces(p_expected_version int, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_srcs jsonb := '[]'::jsonb; v_names text[] := '{}'; v_roles text[] := '{}'; v_focus text[] := '{}';
  v_item jsonb; v_clean text[]; v_cur int; v_same boolean; v_f text; v_i int := 0;
begin
  perform public._assert_editor();
  if p_items is null or jsonb_typeof(p_items) <> 'array' then perform public._invalid('photos', 'The list could not be read.'); end if;
  if jsonb_array_length(p_items) > 30 then perform public._invalid('photos', 'The list can hold up to 30 people.'); end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    if jsonb_typeof(v_item) <> 'object' then perform public._invalid('photos', 'A photo reference was not valid.'); end if;
    v_srcs  := v_srcs || jsonb_build_array(coalesce(v_item ->> 'src', ''));
    v_names := v_names || public._text(v_item ->> 'name', 'name', 'Name of person ' || v_i, 1, 80);
    v_roles := v_roles || public._text(v_item ->> 'role', 'role', 'Role of person ' || v_i, 0, 60);
    v_f := coalesce(nullif(btrim(v_item ->> 'focus'), ''), 'center 20%');
    if v_f !~ '^(center|top|bottom|left|right)( [0-9]{1,3}%)?$' then v_f := 'center 20%'; end if;
    v_focus := v_focus || v_f;
  end loop;
  v_clean := public._clean_images(v_srcs, 30);
  update public.about_lists_meta set version = version + 1 where kind = 'faces' and version = p_expected_version returning version into v_cur;
  if not found then
    select version into v_cur from public.about_lists_meta where kind = 'faces';
    select coalesce(array_agg(src order by position), '{}') = v_clean and coalesce(array_agg(name order by position), '{}') = v_names
       and coalesce(array_agg(role order by position), '{}') = v_roles
      into v_same from public.about_faces;
    if v_same then return jsonb_build_object('version', v_cur); end if;
    raise exception 'Someone else changed this list after you opened it.' using errcode = 'PT409';
  end if;
  delete from public.about_faces;
  insert into public.about_faces (position, src, name, role, focus)
  select ord - 1, s, n, r, f from unnest(v_clean, v_names, v_roles, v_focus) with ordinality as t(s, n, r, f, ord);
  return jsonb_build_object('version', v_cur);
end $$;

-- About page: editable section headings (added to the list of text settings editors may change).
create or replace function public.editor_save_site(p_expected_version int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := jsonb_build_object(
    'about_kicker', 60, 'about_heading', 120, 'about_heading_italic', 120,
    'about_p1', 800, 'about_p2', 800, 'about_p2_italic', 200,
    'groups_label', 60, 'strip_heading', 80, 'strip_heading_italic', 80, 'faces_label', 60,
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

revoke execute on function public.editor_save_strip(int, jsonb), public.editor_save_faces(int, jsonb) from public, anon, authenticated;
grant  execute on function public.editor_save_strip(int, jsonb), public.editor_save_faces(int, jsonb) to authenticated;
