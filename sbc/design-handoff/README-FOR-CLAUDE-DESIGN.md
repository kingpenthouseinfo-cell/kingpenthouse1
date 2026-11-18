# SBC Website Editor — design hand-off

## What is in this folder
| File | What it is |
|---|---|
| `admin-screens.html` | Every screen of the editor on one page (19 screens, phone size). **Open this in Claude Design and edit it.** |
| `admin.css` | The real stylesheet behind those screens. Colours and sizes are at the top as CSS variables. |
| `assets/` | The logo and a few small sample photos used in the screens. |

## Who uses it and what for
A parish priest with limited computer experience, on a phone (often one-handed, small screen, slow connection).
He adds a short update with photos after a programme activity, fixes a mistake, edits a programme (many photos at once, and short videos), manages the “Who carries the work out” groups on the About page, or changes the contact text. The foundation's owner can also change the bank details. He can sign in with an emailed link or a password.
He opens it, edits, taps **Save**, and the change is live. Saving *is* publishing.

## Please keep (so the editor keeps working and the guide still matches)
- **All wording exactly as it is** — button names, labels and messages (e.g. “Add an update”, “What happened?”, “Save”, “Saved. Your changes are live.”). The printed guide uses them.
- **Every screen, field, button and message** shown. No new screens, no draft, preview, approval or “Publish” step.
- **Mobile first**, working from 320 px to 560 px wide. No sideways scrolling.
- **Big touch targets** (at least 44 px tall) and **18 px or larger text** in forms.
- **Save stays in a bar fixed to the bottom** of form screens.
- Strong contrast, visible focus outlines, errors shown in words (not only colour).
- Brand: SBC Global Foundation, “Love towards humanity”. Greens `#1F5C3E` / `#0A3D28`, cream `#F6F1E1`. The public site uses EB Garamond (headings) with Courier Prime accents; you may bring that feel into the editor.

## You may change freely
Colours, fonts, spacing, corner radii, shadows, icons, header, how buttons and cards look, the home screen layout, the photo-grid style, animations (gentle only).

## Prompt to paste into Claude Design
> Open `admin-screens.html`. It shows every screen of a mobile website editor for a parish priest. Restyle the whole thing so it feels warm, calm and clearly part of the SBC Global Foundation brand (greens and cream, “Love towards humanity”), while staying very simple and easy for a non-technical person. Keep all wording, fields and screens exactly as they are, keep touch targets at least 44 px, text at least 18 px in forms, and the Save bar fixed at the bottom. Make the three buttons on the main screen feel friendly and obvious, with “Add an update” the most prominent. Edit `admin.css` and the HTML together so they stay consistent. Show me the result for all 19 screens at 390 px, and check 320 px too.

## Bringing it back
When you are happy, download the changed `admin-screens.html` and `admin.css` and give them to Claude Code with:
“Port this new design into the real editor (`admin/admin.css` and the screen templates in `admin/admin.js`), keep all behaviour, then re-run the tests.”
Do not paste the screens into the live site by hand: the editor draws its screens with JavaScript, so Claude Code needs to carry the new look into that code.
