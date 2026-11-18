-- Videos go in their own public bucket (photos stay in "media"). Anyone can watch; only signed-in
-- editors can upload, only into a folder named after their own account. 50 MB per file is the most
-- Supabase's free plan allows; larger files are refused by storage itself.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', true, 52428800, array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update
  set public = true, file_size_limit = 52428800,
      allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm'];

drop policy if exists videos_editor_insert on storage.objects;
create policy videos_editor_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'videos'
    and public.is_editor()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
