# Paste everything below the line into Claude Cowork

---

You are setting up the King Penthouse /kp page notifications for me. I'm not technical, so do the clicking for me in my browser and only stop to ask when you truly need me. Never print, repeat or save any password, API key or token in chat; type them straight into the correct field.

## Goal
Every submission from https://kingpenthouse.com/kp must send (1) an email via Resend and (2) a private WhatsApp alert to me via the WhatsApp Business Cloud API. The code is already written and in GitHub (repo kingpenthouse-cell/kingpenthouse1, branch claude/king-penthouse-landing-hemgbq). You only do the accounts and settings.

## Rules
- Do NOT put any phone number, email, token or key anywhere public: not in the website files, GitHub, or chat.
- If a login, 2FA code or payment is needed, stop and tell me exactly what to do, then continue when I say "done".
- Ask me before anything that costs money.

## Steps

### 1. Resend (email)
1. Log in to resend.com (ask me to sign in if needed).
2. Domains > add kingpenthouse.com if missing. Show me the DNS records it wants and add them at my domain registrar/Netlify DNS (ask me to log in). Wait until it says Verified.
3. API Keys > create a key named "kp-rsvp" with "Sending access". Copy it for step 4 only.

### 2. WhatsApp Cloud API (Meta)
1. Go to business.facebook.com and developers.facebook.com. Use the existing app with WhatsApp, or create a Business app and add the WhatsApp product.
2. From WhatsApp > API Setup note: the Phone number ID (the sender).
3. Add MY admin number as a recipient and verify it (I'll type the code). Tell me which number you need; ask me for it, do not guess.
4. Create a permanent token: Business Settings > Users > System users > add "kp-rsvp" (Admin) > assign the WhatsApp app and WhatsApp account > Generate token with whatsapp_business_messaging and whatsapp_business_management, never expires.
5. WhatsApp Manager > Message templates > Create template:
   - Category: Utility, Name: kp_new_rsvp, Language: English
   - Body exactly:
     ```
     👑 King Penthouse — new RSVP
     Name: {{1}}
     Type: {{2}}
     {{3}}: {{4}}
     Found us: {{5}}
     QR source: {{6}}
     Submitted: {{7}}
     ```
   - Provide sample values for {{1}}-{{7}} (e.g. John, Single man, Email, john@example.com, Toronto Sex Show, sexshow, October 17, 2026 at 12:15 AM).
   - Submit and wait for Approved status (usually minutes). Tell me if it's rejected and why.

### 3. Netlify environment variables
Netlify > the kingpenthouse.com site > Site configuration > Environment variables. Add each (mark as Secret, scope: Functions at minimum; NO public prefix):
- RESEND_API_KEY = key from step 1
- KP_NOTIFICATION_EMAIL = my admin email (ask me)
- KP_FROM_EMAIL = KP RSVP <rsvp@kingpenthouse.com>
- WHATSAPP_ACCESS_TOKEN = token from step 2.4
- WHATSAPP_PHONE_NUMBER_ID = from step 2.2
- KP_ADMIN_WHATSAPP_NUMBER = my number, digits with country code (ask me)
- WHATSAPP_TEMPLATE_NAME = kp_new_rsvp
- WHATSAPP_TEMPLATE_LANGUAGE = en

### 4. Deploy
In GitHub, open the branch claude/king-penthouse-landing-hemgbq and ask me whether to merge it into main (do not merge without my yes). Once merged, confirm Netlify finished a successful deploy (Deploys tab). If the deploy fails, copy the error summary to me.

### 5. Test (do it all yourself)
1. Open https://kingpenthouse.com/kp?source=sexshow in a browser.
2. Submit the form with name "TEST", Email, test@example.com, any type, found-us option "Toronto Sex Show", 19+ box ticked.
3. Confirm the page shows REQUEST RECEIVED.
4. Check my admin inbox: subject should look like "NEW KP RSVP: ... | TEST | Toronto Sex Show" and contain QR SOURCE: sexshow.
5. Ask me to confirm the WhatsApp alert arrived on my phone.
6. If either did not arrive, open Netlify > Logs > Functions > kp-rsvp and tell me which channel failed and the fix (usually: domain not verified, template not approved, wrong number format, or wrong variable name). Fix it and retest.

### 6. Privacy check
View the page source of https://kingpenthouse.com/kp and search for: my phone number, my admin email, "wa.me", "token", the venue address. Report that none were found.

### 7. Report back
Give me a short checklist: Resend verified, template approved, env vars set, deployed, email received, WhatsApp received, privacy check passed. Also remind me the QR links:
- https://kingpenthouse.com/kp?source=sexshow
- https://kingpenthouse.com/kp?source=sugardaddys
- https://kingpenthouse.com/kp?source=flyer
