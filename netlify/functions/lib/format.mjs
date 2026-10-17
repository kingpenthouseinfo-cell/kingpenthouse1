// Builds the admin notification content (email + WhatsApp) from a validated submission.

const TZ = "America/Toronto";
const SOURCE_PAGE = "kingpenthouse.com/kp";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatSubmitted(date = new Date()) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return `${day} at ${time} ${TZ}`;
}

export function buildEmail(d, now = new Date()) {
  const rows = [
    ["NAME / ALIAS", d.name],
    ["CONTACT VIA", d.contactMethod],
    [d.contactMethod.toUpperCase(), d.contact],
    ["ATTENDING AS", d.attendingAs],
    ["FOUND KP THROUGH", d.foundUs],
    ["QR SOURCE", d.source || "none"],
    ["SUBMITTED", formatSubmitted(now)],
    ["SOURCE PAGE", SOURCE_PAGE],
  ];
  const subject = `NEW KP RSVP: ${d.attendingAs} | ${d.name} | ${d.foundUs}`.replace(/\s+/g, " ").slice(0, 200);
  const text = ["KING PENTHOUSE", "NEW RSVP / VERIFICATION REQUEST", "", ...rows.flatMap(([k, v]) => [`${k}:`, v, ""])].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#0b0a0c;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#efe6d3">
<div style="max-width:560px;margin:0 auto;border:1px solid #c9a867;padding:28px;background:#14110d">
<div style="letter-spacing:.3em;color:#c9a867;font-size:14px">KING PENTHOUSE</div>
<div style="letter-spacing:.18em;font-size:12px;margin:6px 0 20px;color:#a89a7c">NEW RSVP / VERIFICATION REQUEST</div>
${rows
  .map(([k, v]) => `<div style="margin:0 0 14px"><div style="font-size:11px;letter-spacing:.16em;color:#c9a867">${escapeHtml(k)}</div><div style="font-size:15px;word-break:break-word">${escapeHtml(v)}</div></div>`)
  .join("")}
</div></body></html>`;
  return { subject, text, html };
}

// Single-line, template-safe (Meta rejects newlines/tabs/4+ consecutive spaces in params).
export function waParam(v, max = 200) {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max) || "-";
}

// Named fields that can be mapped to template variables via WHATSAPP_TEMPLATE_PARAMS.
export function buildWhatsAppFields(d, now = new Date()) {
  return {
    name: waParam(d.name, 80),
    type: waParam(d.attendingAs, 30),
    method: waParam(d.contactMethod, 20),
    contact: waParam(d.contact, 120),
    found: waParam(d.foundUs, 100),
    source: waParam(d.source || "none", 32),
    time: waParam(formatSubmitted(now), 60),
  };
}

// Free-form version (used only when no template is configured).
export function buildWhatsAppText(d, now = new Date()) {
  const f = buildWhatsAppFields(d, now);
  return `👑 KING PENTHOUSE\nNEW RSVP\n\nName: ${f.name}\nType: ${f.type}\n${f.method}: ${f.contact}\nFound us: ${f.found}\nQR source: ${f.source}\n\nSubmitted: ${f.time}`;
}
