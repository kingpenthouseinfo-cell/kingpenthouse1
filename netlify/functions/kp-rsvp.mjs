import { validateSubmission } from "./lib/validate.mjs";
import { sendEmail } from "./lib/notify-email.mjs";
import { sendWhatsApp } from "./lib/notify-whatsapp.mjs";
import { rateLimited } from "./lib/ratelimit.mjs";

const MAX_BODY = 8 * 1024;
const GENERIC_ERROR = { ok: false };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

// Same-origin only: reject cross-site browser posts.
function originAllowed(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser / same-origin GET-less posts; the other layers still apply
  try {
    const o = new URL(origin);
    const self = new URL(req.url);
    return o.host === self.host || o.hostname === "kingpenthouse.com" || o.hostname === "www.kingpenthouse.com";
  } catch {
    return false;
  }
}

export default async function handler(req, context, deps = {}) {
  const env = deps.env ?? process.env;
  const email = deps.sendEmail ?? sendEmail;
  const whatsapp = deps.sendWhatsApp ?? sendWhatsApp;

  if (req.method !== "POST") return json(405, GENERIC_ERROR);
  if (!originAllowed(req)) return json(403, GENERIC_ERROR);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    console.warn("[kp-rsvp] rate limited");
    return json(429, { ok: false });
  }

  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, GENERIC_ERROR);
    body = JSON.parse(raw);
  } catch {
    return json(400, GENERIC_ERROR);
  }

  const result = validateSubmission(body);
  if (!result.ok) {
    if (result.bot) {
      console.warn("[kp-rsvp] honeypot triggered");
      return json(200, { ok: true }); // look successful to bots; send nothing
    }
    console.warn("[kp-rsvp] validation failed:", result.errors.join(","));
    return json(400, GENERIC_ERROR);
  }

  const [emailRes, waRes] = await Promise.allSettled([email(result.data, env), whatsapp(result.data, env)]);
  const emailOk = emailRes.status === "fulfilled";
  const waOk = waRes.status === "fulfilled";

  if (!emailOk) console.error("[kp-rsvp] EMAIL notification failed:", emailRes.reason?.message);
  if (!waOk) console.error("[kp-rsvp] WHATSAPP notification failed:", waRes.reason?.message);

  if (!emailOk && !waOk) {
    // Lead would be lost silently otherwise, so let the visitor retry.
    console.error("[kp-rsvp] CRITICAL: both notification channels failed; RSVP not delivered");
    return json(502, GENERIC_ERROR);
  }

  return json(200, { ok: true });
}
