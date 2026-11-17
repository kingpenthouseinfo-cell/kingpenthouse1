-- SBC Global Foundation: editable content schema.
-- Public visitors may READ published content. Nobody can write to these tables
-- directly: every change goes through the editor_* functions below, which check
-- that the caller is a signed-in editor (a row in public.editors).

-- ───────────────────────────── Who may edit ─────────────────────────────
create table public.editors (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);
alter table public.editors enable row level security;
-- An editor can see their own row (so the editor app can say "you're signed in").
-- There is deliberately NO insert/update/delete policy: editors cannot add or
-- remove other editors. The foundation owner does that in the Supabase dashboard.
create policy editors_read_own on public.editors
  for select to authenticated using (user_id = auth.uid());

create function public.is_editor() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.editors e where e.user_id = auth.uid())
$$;

-- ───────────────────────────── Content tables ─────────────────────────────
create table public.programmes (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  -- "position" is the programme's permanent place in the list. The original
  -- eight are 0..7 and old #programme/<n> links point at it. It never changes.
  position    int  not null unique check (position >= 0),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  short_label text not null check (char_length(btrim(short_label)) between 1 and 24),
  context     text not null default '' check (char_length(context) <= 80),
  caption     text not null default '' check (char_length(caption) <= 80),
  description text not null default '' check (char_length(description) <= 800),
  extras      jsonb not null default '{}'::jsonb,   -- video, overlay, before/after (not editor-editable)
  client_token uuid unique,                          -- makes "add programme" safe to retry
  version     int  not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table public.programme_images (
  id           uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  position     int  not null check (position >= 0),
  src          text not null check (src ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$'),
  unique (programme_id, position) deferrable initially deferred
);

create table public.updates (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(btrim(title)) between 1 and 120),
  body         text not null check (char_length(btrim(body)) between 1 and 5000),
  programme_id uuid references public.programmes(id),
  published_at timestamptz not null default now(),   -- original publication time; edits never change it
  removed_at   timestamptz,                          -- "Remove from website" (soft delete)
  client_token uuid unique,
  version      int  not null default 1,
  created_by   uuid,
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);
create index updates_public_idx on public.updates (published_at desc) where removed_at is null;

create table public.update_images (
  id        uuid primary key default gen_random_uuid(),
  update_id uuid not null references public.updates(id) on delete cascade,
  position  int  not null check (position >= 0),
  src       text not null check (src ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$'),
  unique (update_id, position) deferrable initially deferred
);

create table public.site_info (
  id         int primary key check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  version    int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.site_info (id) values (1) on conflict do nothing;

-- A programme's place in the list must never change.
create function public.programmes_keep_position() returns trigger
language plpgsql as $$
begin
  if new.position <> old.position then
    raise exception 'A programme''s position cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger programmes_keep_position before update on public.programmes
  for each row execute function public.programmes_keep_position();

-- ───────────────────────────── Row level security ─────────────────────────────
alter table public.programmes       enable row level security;
alter table public.programme_images enable row level security;
alter table public.updates          enable row level security;
alter table public.update_images    enable row level security;
alter table public.site_info        enable row level security;

create policy programmes_public_read on public.programmes       for select to anon, authenticated using (true);
create policy prog_images_public_read on public.programme_images for select to anon, authenticated using (true);
create policy updates_public_read     on public.updates          for select to anon, authenticated using (removed_at is null);
create policy update_images_public_read on public.update_images  for select to anon, authenticated
  using (exists (select 1 from public.updates u where u.id = update_id and u.removed_at is null));
create policy site_info_public_read   on public.site_info        for select to anon, authenticated using (true);

-- Supabase grants table privileges to anon/authenticated by default. Take them
-- all away, then give back read-only access. Writes happen only via editor_*.
revoke all on public.editors, public.programmes, public.programme_images,
              public.updates, public.update_images, public.site_info
  from public, anon, authenticated;
grant select on public.programmes, public.programme_images, public.updates,
                public.update_images, public.site_info to anon, authenticated;
grant select on public.editors to authenticated;

-- ───────────────────────────── Reading ─────────────────────────────
create function public.content_json(p_versions boolean) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'programmes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', p.id, 'position', p.position, 'name', p.name,
          'short_label', p.short_label, 'context', p.context,
          'caption', p.caption, 'description', p.description, 'extras', p.extras,
          'images', coalesce((select jsonb_agg(i.src order by i.position)
                              from public.programme_images i where i.programme_id = p.id), '[]'::jsonb)
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

-- What the public website reads. Anyone may call it; row-level security applies.
create function public.public_content() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select public.content_json(false) - 'site_version'
$$;

-- ───────────────────────────── Writing (editors only) ─────────────────────────────
create function public._assert_editor() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_editor() then
    raise exception 'You do not have permission to edit this website.' using errcode = '42501';
  end if;
end $$;

create function public._invalid(p_field text, p_message text) returns void
language plpgsql as $$
begin
  raise exception '%', p_message using errcode = 'PT422', detail = p_field;
end $$;

create function public._text(p_val text, p_field text, p_label text, p_min int, p_max int) returns text
language plpgsql as $$
declare v text := btrim(replace(coalesce(p_val, ''), E'\r\n', E'\n'));
begin
  if char_length(v) < p_min then
    perform public._invalid(p_field, 'Please fill in "' || p_label || '".');
  end if;
  if char_length(v) > p_max then
    perform public._invalid(p_field, '"' || p_label || '" is too long (the limit is ' || p_max || ' characters).');
  end if;
  return v;
end $$;

-- Photos: either a bundled file name (e.g. food-van.jpg) or a path in the "media"
-- storage bucket that really exists there (<editor id>/<uuid>.jpg).
create function public._clean_images(p_images jsonb, p_max int) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_out text[] := '{}'; v text; v_item jsonb;
begin
  if p_images is null or jsonb_typeof(p_images) <> 'array' then return v_out; end if;
  if jsonb_array_length(p_images) > p_max then
    perform public._invalid('photos', 'Too many photos (the limit is ' || p_max || ').');
  end if;
  for v_item in select * from jsonb_array_elements(p_images) loop
    if jsonb_typeof(v_item) <> 'string' then perform public._invalid('photos', 'A photo reference was not valid.'); end if;
    v := btrim(v_item #>> '{}');
    if v ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$' then
      null; -- bundled website photo
    elsif v ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' then
      if to_regclass('storage.objects') is null
         or not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = v) then
        perform public._invalid('photos', 'A photo did not finish uploading. Please try again.');
      end if;
    else
      perform public._invalid('photos', 'A photo reference was not valid.');
    end if;
    v_out := v_out || v;
  end loop;
  return v_out;
end $$;

create function public._same_images(p_table text, p_id uuid, p_imgs text[]) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_cur text[];
begin
  if p_table = 'u' then
    select coalesce(array_agg(src order by position), '{}') into v_cur from public.update_images where update_id = p_id;
  else
    select coalesce(array_agg(src order by position), '{}') into v_cur from public.programme_images where programme_id = p_id;
  end if;
  return v_cur = p_imgs;
end $$;

-- Everything the editor app needs (includes version numbers for conflict checks).
create function public.editor_content() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._assert_editor();
  return public.content_json(true);
end $$;

create function public.editor_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._assert_editor();
  return (select jsonb_build_object('email', e.email) from public.editors e where e.user_id = auth.uid());
end $$;

-- Add or correct an update. p_id null = new update.
create function public.editor_save_update(
  p_id uuid, p_expected_version int, p_title text, p_body text,
  p_programme_id uuid, p_images jsonb, p_client_token uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_title text; v_body text; v_imgs text[]; v_row public.updates;
begin
  perform public._assert_editor();
  v_title := public._text(p_title, 'title', 'Title', 1, 120);
  v_body  := public._text(p_body, 'body', 'What happened?', 1, 5000);
  v_imgs  := public._clean_images(p_images, 12);
  if p_programme_id is not null and not exists (select 1 from public.programmes where id = p_programme_id) then
    perform public._invalid('programme', 'Please choose a programme from the list.');
  end if;

  if p_id is null then
    if p_client_token is not null then   -- a retry of a save that already went through
      select * into v_row from public.updates where client_token = p_client_token;
      if found then
        return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'published_at', v_row.published_at);
      end if;
    end if;
    insert into public.updates (title, body, programme_id, client_token, created_by, updated_by)
    values (v_title, v_body, p_programme_id, p_client_token, auth.uid(), auth.uid())
    returning * into v_row;
  else
    update public.updates
       set title = v_title, body = v_body, programme_id = p_programme_id,
           version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = p_id and version = p_expected_version and removed_at is null
    returning * into v_row;
    if not found then
      select * into v_row from public.updates where id = p_id and removed_at is null;
      if not found then
        raise exception 'This update is no longer on the website.' using errcode = 'PT404';
      end if;
      -- already saved with exactly these values (a retry)? then it is a success.
      if v_row.title = v_title and v_row.body = v_body
         and v_row.programme_id is not distinct from p_programme_id
         and public._same_images('u', v_row.id, v_imgs) then
        return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'published_at', v_row.published_at);
      end if;
      raise exception 'Someone else changed this update after you opened it.' using errcode = 'PT409';
    end if;
    delete from public.update_images where update_id = v_row.id;
  end if;

  insert into public.update_images (update_id, position, src)
  select v_row.id, ord - 1, s from unnest(v_imgs) with ordinality as t(s, ord);
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'published_at', v_row.published_at);
end $$;

-- "Remove from website": hides the update; the record is kept.
create function public.editor_remove_update(p_id uuid, p_expected_version int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.updates;
begin
  perform public._assert_editor();
  select * into v_row from public.updates where id = p_id;
  if not found or v_row.removed_at is not null then return jsonb_build_object('removed', true); end if; -- already gone
  if v_row.version <> p_expected_version then
    raise exception 'Someone else changed this update after you opened it.' using errcode = 'PT409';
  end if;
  update public.updates set removed_at = now(), version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = p_id;
  return jsonb_build_object('removed', true);
end $$;

create function public._slugify(p text) returns text
language sql immutable as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(p), '[^a-z0-9]+', '-', 'g'), '-'), 50), ''), 'programme')
$$;

-- Add or correct a programme. p_id null = new programme (placed after the others).
create function public.editor_save_programme(
  p_id uuid, p_expected_version int, p_name text, p_short_label text, p_context text,
  p_caption text, p_description text, p_images jsonb, p_client_token uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text; v_short text; v_ctx text; v_cap text; v_desc text; v_imgs text[];
  v_row public.programmes; v_slug text; v_n int := 1; v_base text;
begin
  perform public._assert_editor();
  v_name  := public._text(p_name, 'name', 'Programme name', 1, 80);
  v_short := public._text(p_short_label, 'short_label', 'Short name for the menu', 1, 24);
  v_ctx   := public._text(p_context, 'context', 'Where it happens', 0, 80);
  v_cap   := public._text(p_caption, 'caption', 'Caption under the main photo', 0, 80);
  v_desc  := public._text(p_description, 'description', 'Description', 0, 800);
  v_imgs  := public._clean_images(p_images, 24);

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
         and public._same_images('p', v_row.id, v_imgs) then
        return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
      end if;
      raise exception 'Someone else changed this programme after you opened it.' using errcode = 'PT409';
    end if;
    delete from public.programme_images where programme_id = v_row.id;
  end if;

  insert into public.programme_images (programme_id, position, src)
  select v_row.id, ord - 1, s from unnest(v_imgs) with ordinality as t(s, ord);
  return jsonb_build_object('id', v_row.id, 'version', v_row.version, 'position', v_row.position);
end $$;

-- Site information. Only the keys listed here can ever be written, so things like
-- the Give page's bank details are not reachable from the editor.
create function public.editor_save_site(p_expected_version int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := jsonb_build_object(
    'about_kicker', 60, 'about_heading', 120, 'about_heading_italic', 120,
    'about_p1', 800, 'about_p2', 800, 'about_p2_italic', 200,
    'partner1_title', 80, 'partner1_text', 300,
    'partner2_title', 80, 'partner2_text', 300,
    'partner3_title', 80, 'partner3_text', 300,
    'contact_email', 120, 'contact_phone', 40, 'contact_address', 240);
  v_clean jsonb := '{}'::jsonb; v_key text; v_val text; v_cur public.site_info;
begin
  perform public._assert_editor();
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    perform public._invalid('site', 'Nothing to save.');
  end if;
  for v_key in select jsonb_object_keys(p_data) loop
    if not v_allowed ? v_key then
      perform public._invalid(v_key, 'That setting cannot be changed here.');
    end if;
    v_val := public._text(p_data ->> v_key, v_key, v_key, 0, (v_allowed ->> v_key)::int);
    if v_key = 'contact_email' and v_val <> '' and v_val !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform public._invalid('contact_email', 'That email address does not look right.');
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;

  update public.site_info
     set data = data || v_clean, version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = 1 and version = p_expected_version
  returning * into v_cur;
  if not found then
    select * into v_cur from public.site_info where id = 1;
    if v_cur.data @> v_clean then   -- already saved (a retry)
      return jsonb_build_object('version', v_cur.version);
    end if;
    raise exception 'Someone else changed the site information after you opened it.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('version', v_cur.version);
end $$;

-- Function permissions: nothing is callable by default.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.public_content(), public.content_json(boolean) to anon, authenticated;
grant execute on function public.editor_content(), public.editor_me(),
  public.editor_save_update(uuid,int,text,text,uuid,jsonb,uuid),
  public.editor_remove_update(uuid,int),
  public.editor_save_programme(uuid,int,text,text,text,text,text,jsonb,uuid),
  public.editor_save_site(int,jsonb)
  to authenticated;
-- RLS policies call is_editor() on behalf of the caller:
grant execute on function public.is_editor() to authenticated;
