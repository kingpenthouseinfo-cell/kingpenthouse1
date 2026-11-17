# SBC Global Foundation — website and editor

The existing SBC Global Foundation website, plus a private, phone-friendly editor so a priest or staff member can add updates
and photos, correct them, edit programmes and the About page, and see the change on the live site the moment they tap **Save**.

| | |
|---|---|
| Public site | `/` (routes `#home` `#programmes` `#gallery` `#about` `#give`, `#programme/<n>`, new: `#updates`, `#update/<id>`) |
| Editor | `/admin/` |
| Editor guide | [docs/EDITOR-GUIDE.md](docs/EDITOR-GUIDE.md) |
| Owner setup guide | [docs/OWNER-SETUP.md](docs/OWNER-SETUP.md) |

```bash
npm install
npm run dev     # local site + editor + local stand-in backend  → http://localhost:8787  (editor: /admin/)
npm test        # database/permission tests and browser tests
npm run build   # makes dist/ (what gets published)
```

Layout: `index.html` + `support.js` (the site; do not edit `support.js`), `content.js`/`config.js` (content layer),
`admin/` (editor), `supabase/migrations/` (database, security rules, photo storage), `dev/` (local stand-in backend),
`tests/`, `scripts/`, `docs/`.
