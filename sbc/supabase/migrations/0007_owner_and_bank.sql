-- Owners: a trusted editor (the foundation's owner login) who can also change the Give page's bank details.
-- Ordinary editors cannot. Run on a database that already has 0001-0006.
alter table public.editors add column is_owner boolean not null default false;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.editors e where e.user_id = auth.uid() and e.is_owner)
$$;

create or replace function public.editor_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._assert_editor();
  return (select jsonb_build_object('email', e.email, 'owner', e.is_owner) from public.editors e where e.user_id = auth.uid());
end $$;

-- Owner tools (run from the Supabase SQL Editor; not callable by the website, editors or the public).
--   select public.add_editor('priest@example.org');            -- an ordinary editor
--   select public.add_editor('owner@example.org', true);       -- an editor who can also change the bank details
--   select public.set_owner('someone@example.org', true);      -- promote / demote an existing editor
drop function public.add_editor(text);
create function public.add_editor(p_email text, p_owner boolean default false) returns text
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then
    raise exception 'No user with that email exists yet. Add them first under Authentication → Users.';
  end if;
  insert into public.editors (user_id, email, is_owner) values (v_id, lower(btrim(p_email)), coalesce(p_owner, false))
  on conflict (user_id) do update set is_owner = public.editors.is_owner or excluded.is_owner;
  return 'ok: ' || lower(btrim(p_email)) || ' can now edit the website' || case when p_owner then ' and change the bank details' else '' end;
end $$;

create function public.set_owner(p_email text, p_owner boolean) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.editors set is_owner = p_owner where lower(email) = lower(btrim(p_email));
  if not found then raise exception 'That person is not an editor yet. Use add_editor first.'; end if;
  return 'ok: ' || lower(btrim(p_email)) || case when p_owner then ' is now an owner' else ' is no longer an owner' end;
end $$;

-- The Give page's bank details. Only an owner can change them; they are shown publicly on the Give page.
create function public.editor_save_bank(p_expected_version int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_allowed jsonb := jsonb_build_object('bank_account_name', 80, 'bank_name', 80, 'bank_branch', 80,
                                         'bank_account_no', 40, 'bank_swift', 20, 'bank_reference', 80);
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
      if v_val !~ '^([A-Z0-9]{8}|[A-Z0-9]{11})?$' then perform public._invalid(v_key, 'A SWIFT / BIC code has 8 or 11 letters and numbers.'); end if;
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;
  update public.site_info set data = data || v_clean, version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = 1 and version = p_expected_version returning * into v_cur;
  if not found then
    select * into v_cur from public.site_info where id = 1;
    if v_cur.data @> v_clean then return jsonb_build_object('version', v_cur.version); end if;   -- already saved (a retry)
    raise exception 'Someone else changed the site information after you opened it.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('version', v_cur.version);
end $$;

revoke execute on function public.is_owner(), public.editor_me(), public.add_editor(text, boolean), public.set_owner(text, boolean),
  public.editor_save_bank(int, jsonb) from public, anon, authenticated;
grant execute on function public.is_owner(), public.editor_me(), public.editor_save_bank(int, jsonb) to authenticated;
