// netlify/functions/kp-rsvp.js — King Penthouse /kp form handler
// All private values come from Netlify env vars. Nothing private is returned to the browser.

const ALLOWED = {
  contactMethod: ["Email", "WhatsApp"],
  attendingAs: ["Single woman", "Single man", "Couple", "Other"],
  foundUs: ["Sugar Daddy's", "Toronto Sex Show", "Other"]
};
const hits = new Map(); // best-effort per-instance rate limit
const LIMIT = 5, WINDOW = 10 * 60 * 1000;

const clean = (v, max = 200) => String(v ?? "").replace(/[<>\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ok = () => ({ statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) });
const bad = (code = 400) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false }) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405);

  const ip = event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (list.length >= LIMIT) return bad(429);
  list.push(now); hits.set(ip, list);

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return bad(); }

  if (b.company) return ok(); // honeypot: pretend success

  const name = clean(b.name, 80);
  const contactMethod = clean(b.contactMethod, 20);
  const contact = clean(b.contact, 120);
  const attendingAs = clean(b.attendingAs, 30);
  let foundUs = clean(b.foundUs, 100);
  const source = /^[a-z0-9_-]{1,32}$/i.test(b.source || "") ? b.source.toLowerCase() : "";

  const foundBase = foundUs.startsWith("Other:") ? "Other" : foundUs;
  if (!name) return bad();
  if (!ALLOWED.contactMethod.includes(contactMethod)) return bad();
  if (contactMethod === "Email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) return bad();
  if (contactMethod === "WhatsApp" && contact.replace(/\D/g, "").length < 10) return bad();
  if (!ALLOWED.attendingAs.includes(attendingAs)) return bad();
  if (!ALLOWED.foundUs.includes(foundBase)) return bad();
  if (foundBase === "Other" && foundUs.replace(/^Other:\s*/, "").length < 1) return bad();
  if (b.ageConfirmed !== true) return bad();

  const submitted = new Date().toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "long", timeStyle: "short" });
  const d = { name, contactMethod, contact, attendingAs, foundUs, source: source || "none", submitted };

  const results = await Promise.allSettled([sendEmail(d), sendWhatsApp(d)]);
  const [em, wa] = results;
  if (em.status === "rejected") console.error("KP RSVP email failed:", em.reason?.message || em.reason);
  if (wa.status === "rejected") console.error("KP RSVP WhatsApp failed:", wa.reason?.message || wa.reason);
  if (em.status === "rejected" && wa.status === "rejected") console.error("KP RSVP SERIOUS: both notifications failed", JSON.stringify({ name, attendingAs, submitted }));

  return ok();
};

async function sendEmail(d) {
  const { RESEND_API_KEY, KP_NOTIFICATION_EMAIL, KP_FROM_EMAIL } = process.env;
  if (!RESEND_API_KEY || !KP_NOTIFICATION_EMAIL || !KP_FROM_EMAIL) throw new Error("email env missing");
  const rows = [
    ["NAME / ALIAS", d.name], ["CONTACT VIA", d.contactMethod], [d.contactMethod.toUpperCase(), d.contact],
    ["ATTENDING AS", d.attendingAs], ["FOUND KP THROUGH", d.foundUs], ["QR SOURCE", d.source],
    ["SUBMITTED", d.submitted + " America/Toronto"], ["SOURCE PAGE", "kingpenthouse.com/kp"]
  ];
  const text = "KING PENTHOUSE\nNEW RSVP / VERIFICATION REQUEST\n\n" + rows.map(([k, v]) => k + ":\n" + v).join("\n\n");
  const html = "<h2>KING PENTHOUSE</h2><p><b>NEW RSVP / VERIFICATION REQUEST</b></p>" + rows.map(([k, v]) => "<p><b>" + k + ":</b><br>" + esc(v) + "</p>").join("");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: KP_FROM_EMAIL, to: [KP_NOTIFICATION_EMAIL], subject: `NEW KP RSVP: ${d.attendingAs} | ${d.name} | ${d.foundUs}`, text, html })
  });
  if (!r.ok) throw new Error("Resend " + r.status + " " + (await r.text()).slice(0, 300));
}

async function sendWhatsApp(d) {
  const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, KP_ADMIN_WHATSAPP_NUMBER, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANGUAGE } = process.env;
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !KP_ADMIN_WHATSAPP_NUMBER) throw new Error("whatsapp env missing");
  const p = s => String(s).replace(/[\n\t]+/g, " ").replace(/ {4,}/g, "   ").slice(0, 200) || "-";
  let message;
  if (WHATSAPP_TEMPLATE_NAME) {
    // Template body params, in order: {{1}} name, {{2}} type, {{3}} contact method, {{4}} contact, {{5}} found us, {{6}} QR source, {{7}} time
    message = {
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATE_NAME,
        language: { code: WHATSAPP_TEMPLATE_LANGUAGE || "en" },
        components: [{ type: "body", parameters: [d.name, d.attendingAs, d.contactMethod, d.contact, d.foundUs, d.source, d.submitted].map(t => ({ type: "text", text: p(t) })) }]
      }
    };
  } else {
    // Free-form text only works inside a 24h customer-service window. Use a template in production.
    message = { type: "text", text: { body: `👑 KING PENTHOUSE\nNEW RSVP\n\nName: ${d.name}\nType: ${d.attendingAs}\n${d.contactMethod}: ${d.contact}\nFound us: ${d.foundUs}\nQR source: ${d.source}\n\nSubmitted: ${d.submitted}` } };
  }
  const r = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer " + WHATSAPP_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: KP_ADMIN_WHATSAPP_NUMBER.replace(/\D/g, ""), ...message })
  });
  if (!r.ok) throw new Error("WhatsApp " + r.status + " " + (await r.text()).slice(0, 300));
}
