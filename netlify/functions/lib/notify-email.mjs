import { buildEmail } from "./format.mjs";

export async function sendEmail(d, env, fetchImpl = fetch) {
  const { RESEND_API_KEY, KP_NOTIFICATION_EMAIL, KP_FROM_EMAIL } = env;
  if (!RESEND_API_KEY || !KP_NOTIFICATION_EMAIL || !KP_FROM_EMAIL) {
    throw new Error("email not configured (RESEND_API_KEY / KP_NOTIFICATION_EMAIL / KP_FROM_EMAIL)");
  }
  const { subject, text, html } = buildEmail(d);
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: KP_FROM_EMAIL,
      to: KP_NOTIFICATION_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
      ...(d.contactMethod === "Email" ? { reply_to: d.contact } : {}), // admin can reply straight to the guest
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`resend ${res.status}: ${detail}`);
  }
}
