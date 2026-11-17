-- Tools for the foundation OWNER, run from the Supabase "SQL Editor" (which runs as the database owner).
-- They are not available to the website, to editors, or to the public.
--   select public.add_editor('priest@example.org');      -- the person must already exist under Authentication → Users
--   select public.remove_editor('priest@example.org');
--   select * from public.editors;                          -- who can edit right now
create function public.add_editor(p_email text) returns text
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then
    raise exception 'No user with that email exists yet. Add them first under Authentication → Users.';
  end if;
  insert into public.editors (user_id, email) values (v_id, lower(btrim(p_email))) on conflict (user_id) do nothing;
  return 'ok: ' || lower(btrim(p_email)) || ' can now edit the website';
end $$;

create function public.remove_editor(p_email text) returns text
language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  delete from public.editors where lower(email) = lower(btrim(p_email));
  return 'ok: ' || lower(btrim(p_email)) || ' can no longer edit the website (their account still exists; remove it under Authentication → Users to be thorough)';
end $$;

revoke execute on function public.add_editor(text), public.remove_editor(text) from public, anon, authenticated;
