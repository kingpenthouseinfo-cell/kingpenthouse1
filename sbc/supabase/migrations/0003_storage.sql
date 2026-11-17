-- Photo storage. One public bucket called "media". Anyone can VIEW a photo by its
-- address; only signed-in editors can UPLOAD, and only into a folder named after
-- their own account. Nobody can overwrite or delete through the API.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists media_editor_insert on storage.objects;
create policy media_editor_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and public.is_editor()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
