# Owner setup guide — SBC Global Foundation website

This explains how to run the site on a computer, connect it to its storage, put it online, and look after it.
Nothing here has been deployed or connected to the live domain: those steps are yours to approve (see §5).

## 1. What this is

| Part | Where | What it does |
|---|---|---|
| Public website | `index.html`, `support.js`, `assets/` | The existing SBC site, unchanged in look. |
| Content layer | `content.js`, `config.js` | Reads live content (programmes, updates, About text); falls back to the built-in copy if it can't. |
| Editor | `admin/` (opens at `/admin/`) | The phone-friendly editor for the priest. |
| Backend | **Supabase** (`supabase/migrations/`) | Sign-in, the database, and photo storage. |
| Hosting | **Netlify** or **Cloudflare Pages** | Serves the static files (`dist/`). |

**Why Supabase:** the workspace had no existing backend or hosting. Supabase gives sign-in by email link, a real database with
row-level security (so permissions are enforced by the database, not by hiding a page) and photo storage in one place, with a free
tier that is enough here. Hosting stays a plain static site; no framework was added.

## 2. Accounts the foundation should own

Create these under a **foundation email address** (not a personal one), with two trusted people having access:

1. **Supabase** (database, sign-in, photos) — supabase.com
2. **Netlify** or **Cloudflare Pages** (hosting) — connected to the GitHub repository
3. **GitHub** — the repository `kingpenthouseinfo-cell/kingpenthouse1` (folder `sbc/`)
4. **An email-sending service** for sign-in emails (see §4.4) — e.g. Resend, Brevo or a Google Workspace mailbox
5. The **domain registrar** — already yours; not changed by anything here

## 3. Run it on a computer (no accounts needed)

Needs Node.js 20 or newer.

```bash
cd sbc
npm install
npm run dev          # site: http://localhost:8787/   editor: http://localhost:8787/admin/
npm test             # 19 database/permission tests + 24 browser tests
```

`npm run dev` starts a **local stand-in** for Supabase (a real Postgres running the real migrations, with fake sign-in emails).
Sign-in "emails" appear at `http://localhost:8787/__dev/outbox?email=priest@example.org`. Nothing is sent anywhere, and data
resets each time you restart it. Browser tests need Playwright (`npm i -D playwright && npx playwright install chromium`).

## 4. Set up Supabase (once)

1. **Create a project** at supabase.com. Choose a region near Sri Lanka/your users (e.g. Singapore). Save the database password in the foundation's password manager.
2. **Create the tables and rules.** Dashboard → **SQL Editor** → run each file from `sbc/supabase/migrations/` **in order**, pasting the whole file each time:
   `0001_schema.sql`, `0002_seed_content.sql`, `0003_storage.sql`, `0004_owner_tools.sql`.
   (With the Supabase CLI instead: `supabase link --project-ref <ref>` then `supabase db push`.)
   `0002` loads the eight original programmes and the About wording. It is **safe to run again**: it never duplicates a programme or undoes an edit.
3. **Make sign-in invite-only.** Dashboard → Authentication → *Sign In / Providers* → Email: switch **off** “Allow new users to sign up”.
4. **Sign-in emails.**
   - Authentication → *URL Configuration*: set **Site URL** to `https://YOUR-DOMAIN/admin/` and add `https://YOUR-DOMAIN/admin/` (and your Netlify/Cloudflare preview address `/admin/`) under **Redirect URLs**.
   - Authentication → *Email Templates* → **Magic Link**: paste the contents of `supabase/templates/magic-link.html` (it adds the 6-digit code as a backup).
   - **Important:** Supabase's built-in email sender is only for testing and allows just a few emails per hour. For real use set up **custom SMTP**: Authentication → *SMTP Settings* with your email service. Without this the priest may not receive his link.
5. **Add the first editor.** Authentication → *Users* → **Add user → Create new user**: type the priest's email, tick **Auto Confirm User**. Then in the SQL Editor:
   ```sql
   select public.add_editor('priest@example.org');
   ```
6. **Find your two public values.** Project Settings → *API*: **Project URL** and the **anon / publishable** key. These are *public by design*. **Never** use or share the `service_role` / secret key; nothing here needs it.

## 5. Connect and publish the website (not done yet)

Hosting setup (Netlify shown; Cloudflare Pages is the same):
1. New site → import from GitHub → choose the repository.
2. **Base directory:** `sbc` · **Build command:** `node scripts/build.mjs` · **Publish directory:** `sbc/dist`
3. Site settings → *Environment variables*: `SUPABASE_URL` = your Project URL, `SUPABASE_ANON_KEY` = the public key (see `.env.example`).
4. Deploy. Open the preview address, then `…/admin/`.
5. Only when you are happy: add the real domain in the host's *Domain* settings and follow its DNS instructions.

The build publishes only the website and editor (`dist/`): never the database files, tests or scripts.

### Exact actions to go live from this workspace
1. Review the branch `claude/great-goodall-38pp4y` (folder `sbc/`) and merge it to your main branch when you approve.
2. Do §4 (Supabase) and §5 (hosting) above.
3. Run the real-phone checklist (§8) on the preview address.
4. Only then connect the live domain.

## 6. Looking after editors

| Task | How |
|---|---|
| **Invite** a new editor | Authentication → Users → *Add user → Create new user* (tick Auto Confirm), then `select public.add_editor('new@example.org');` |
| **Replace** an editor (priest moves on) | Add the new person as above, then remove the old one. |
| **Revoke** an editor | `select public.remove_editor('old@example.org');` takes away editing immediately. Then delete their user under Authentication → Users to end their sign-in. |
| **Who can edit now?** | `select * from public.editors;` |
| **Someone can't sign in** | They tap **Email me a sign-in link** again (or use the 6-digit code). Check their email is spelled the same in Authentication → Users. If emails never arrive, check SMTP (§4.4) and the spam folder. |

Editors cannot add, remove or change other editors, change the Give page's bank details, or change sign-in settings. The bank details are not in the database at all: they live in `index.html` (`bank:` list) and the owner changes them there.

## 7. Backups and recovery

- **Database:** Supabase → Database → *Backups*. Daily backups are included on paid plans; on the free plan, export regularly: SQL Editor → run
  `select * from public.updates;` etc. and download, or use `supabase db dump` from a computer. Do this monthly and keep the files with the foundation.
- **Photos:** Supabase → Storage → `media`. They are only ever added, never deleted by the editor. Download the bucket occasionally.
- **Website files:** safe in GitHub.
- **A change was wrong:** an *update* can be removed or corrected from the editor. Anything else can be corrected by editing again. To undo a removed update: `update public.updates set removed_at = null where id = '…';`
- **Total loss of the Supabase project:** create a new project, run the four migration files, restore the exported data, re-add editors, and update the two environment variables on the host. The site shows its built-in content meanwhile.
- **Unused photos** (uploaded but later removed from every update/programme) stay in storage. They are harmless; clear them by hand only if space becomes a problem.

## 8. Test on real phones before trusting it

Automated tests in this project used a **desktop browser emulating phone sizes** (320 px and 390 px). They have **not** been run on a real
iPhone or Android phone. Before handing over, on the preview address, on both an iPhone (Safari) and an Android phone (Chrome):

1. Sign in from the email link, and once using the 6-digit code.
2. Add an update with a photo taken with the camera, and one chosen from the library. Check the photo is upright on the website.
3. Type in the “What happened?” box with the keyboard open: the **Save** button must stay reachable.
4. Add the page to the Home Screen, close it, reopen it and check you are still signed in.
5. Edit a programme's description, an update, and the About text; refresh the public site on another phone.

## 9. How it works (for whoever maintains it)

- Public pages read one function, `public_content()`. Nothing caches it: it is fetched fresh on each visit, so a saved change appears on the next refresh. If it fails the site shows the last copy the browser remembered, else the built-in content.
- **Every write** goes through a database function (`editor_save_update`, `editor_save_programme`, `editor_save_site`, `editor_remove_update`) that first checks the caller is in `public.editors`. The tables have no write access for the public or for signed-in users; this is verified by `tests/db.test.mjs`.
- Saving is safe to repeat: a retry reuses an idempotency token, finished photo uploads are remembered, and an identical retry of an already-saved edit counts as success. A version number stops one editor silently overwriting another.
- Photos are shrunk to 1600 px and re-encoded on the phone (which also removes location data); the storage bucket independently accepts only JPEG/PNG/WebP up to 5 MB, only from editors, only into their own folder.
- Programmes keep a permanent `position`. The original eight are 0–7, so old links `#programme/0` … `#programme/7` keep working; new programmes get 8, 9, …
- `index.html` still holds the built-in copy of everything (`PROGS`). `scripts/generate-seed.mjs` rebuilds `0002_seed_content.sql` from it.
- `support.js` is generated by the design tool; do not edit it.

## 10. Known limits of this first version

- Photos only (no video uploads); programme order, programme deletion and update deletion (beyond *Remove from website*) are not in the editor.
- The page's built-in videos, sanitation before/after comparisons and branding are not editable by editors.
- The Give page's “Copy account details” button copies only the organisation name (`SBC Global Foundation`) — that is what the original site does, and it is unchanged. Bank name and account number still say “To be added” in `index.html`.
- Not yet checked against a real Supabase project (see the report): the migrations and rules are tested on a real Postgres engine, and the sign-in/storage calls follow Supabase's documented API, but the final end-to-end run on a live project is your first step after §4.
