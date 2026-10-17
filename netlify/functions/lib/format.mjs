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

export function formatTimestamps(date = new Date()) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return { full: `${day} at ${time} ${TZ}`, time };
}

const dash = (v) => (v && String(v).trim() ? v : "—");

export function buildEmail(d, now = new Date()) {
  const ts = formatTimestamps(now);
  const sourceTag = d.source || "none";
  const subject = `NEW KP RSVP: ${d.eventShort} | ${d.guestType} | ${d.name}`.replace(/\s+/g, " ").slice(0, 200);

  const rows = [
    ["EVENT", d.event],
    ["NAME / ALIAS", d.name],
    ["AGE", String(d.age)],
    ["ATTENDING AS", d.guestType],
    ["EMAIL", d.email],
    ["FETLIFE", dash(d.fetlife)],
    ["FOUND KP THROUGH", d.foundVia],
    ["TRACKING SOURCE", sourceTag],
    ["MESSAGE", dash(d.message)],
    ["SUBMITTED", ts.full],
    ["SOURCE PAGE", SOURCE_PAGE],
  ];

  const text = ["KING PENTHOUSE", "NEW RSVP / VERIFICATION REQUEST", "", ...rows.flatMap(([k, v]) => [`${k}:`, v, ""])].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#0b0a0c;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#efe6d3">
<div style="max-width:560px;margin:0 auto;border:1px solid #c9a867;padding:28px;background:#14110d">
<div style="letter-spacing:.3em;color:#c9a867;font-size:14px">KING PENTHOUSE</div>
<div style="letter-spacing:.18em;font-size:12px;margin:6px 0 20px;color:#a89a7c">NEW RSVP / VERIFICATION REQUEST</div>
<div style="font-size:20px;color:#f3e3bc;margin-bottom:18px">${escapeHtml(d.event)}</div>
${rows
  .slice(1)
  .map(
    ([k, v]) =>
      `<div style="margin:0 0 14px"><div style="font-size:11px;letter-spacing:.16em;color:#c9a867">${k}</div><div style="font-size:15px;white-space:pre-wrap;word-break:break-word">${escapeHtml(v)}</div></div>`,
  )
  .join("")}
</div></body></html>`;

  return { subject, text, html };
}

// Single-line, template-safe (Meta rejects newlines/tabs/4+ spaces inside template params).
export function waParam(v, max = 300) {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, max) || "-";
}

export function buildWhatsAppFields(d, now = new Date()) {
  const ts = formatTimestamps(now);
  return {
    event: waParam(`${d.eventShort}`, 60),
    name: waParam(d.name, 80),
    age: waParam(d.age, 3),
    type: waParam(d.guestType, 30),
    email: waParam(d.email, 254),
    fetlife: waParam(d.fetlife, 40),
    found: waParam(d.foundVia, 40),
    source: waParam(d.source || "none", 30),
    message: waParam(d.message, 500),
    time: waParam(ts.time, 20),
    eventEmoji: d.eventEmoji,
    eventLabel: d.event,
  };
}

// Free-form text version (used only when no template is configured).
export function buildWhatsAppText(d, now = new Date()) {
  const f = buildWhatsAppFields(d, now);
  return [
    "👑 KING PENTHOUSE",
    "NEW RSVP",
    "",
    `${f.eventEmoji} ${f.eventLabel}`,
    `Name: ${f.name}`,
    `Age: ${f.age}`,
    `Type: ${f.type}`,
    `Email: ${f.email}`,
    `FetLife: ${f.fetlife}`,
    `Found us: ${f.found}`,
    `Source: ${f.source}`,
    "Message:",
    f.message,
    `Submission: ${f.time}`,
  ].join("\n");
}
