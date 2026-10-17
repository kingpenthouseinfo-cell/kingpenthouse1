// Server-side validation + sanitization for /kp submissions (contract: see kp.html submit()).
// Nothing here trusts the browser: every value is re-checked and normalised.

export const CONTACT_METHODS = ["Email", "WhatsApp"];
export const ATTENDING_AS = ["Single woman", "Single man", "Couple", "Other"];
export const FOUND_US = ["Sugar Daddy's", "Toronto Sex Show", "Other"];

// Control chars, bidi overrides, zero-width chars and line/paragraph separators.
const INVISIBLE_OR_CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

// Single-line clean: strip control chars and angle brackets, collapse whitespace, cap length.
export function cleanLine(value, max) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(INVISIBLE_OR_CONTROL, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PHONE_RE = /^\+?[0-9 ()._-]{7,30}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/i;

/**
 * @returns {{ ok: true, data: object } | { ok: false, bot?: boolean, errors: string[] }}
 */
export function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["body"] };

  // Honeypot ("company"): real visitors never fill it. Caller fakes success.
  if (typeof body.company === "string" && body.company.trim() !== "") return { ok: false, bot: true, errors: ["honeypot"] };

  const errors = [];

  const name = cleanLine(body.name, 80);
  if (!name) errors.push("name");

  const contactMethod = typeof body.contactMethod === "string" ? body.contactMethod : "";
  if (!CONTACT_METHODS.includes(contactMethod)) errors.push("contactMethod");

  let contact = cleanLine(body.contact, 120);
  if (contactMethod === "Email") {
    contact = contact.toLowerCase();
    if (!EMAIL_RE.test(contact) || contact.length > 254) errors.push("contact");
  } else if (contactMethod === "WhatsApp") {
    const digits = contact.replace(/\D/g, "");
    if (!PHONE_RE.test(contact) || digits.length < 10 || digits.length > 15) errors.push("contact");
  }

  const attendingAs = typeof body.attendingAs === "string" ? body.attendingAs : "";
  if (!ATTENDING_AS.includes(attendingAs)) errors.push("attendingAs");

  // "Sugar Daddy's" | "Toronto Sex Show" | "Other: <free text>"
  const foundRaw = cleanLine(body.foundUs, 100);
  let foundUs = foundRaw;
  if (foundRaw === "Other" || foundRaw.startsWith("Other:")) {
    const detail = foundRaw.replace(/^Other:?\s*/, "");
    if (!detail) errors.push("foundUs");
    foundUs = `Other: ${detail}`;
  } else if (!FOUND_US.includes(foundRaw) || foundRaw === "Other") {
    errors.push("foundUs");
  }

  // Server-side age gate: explicit confirmation of 19+ is mandatory.
  if (body.ageConfirmed !== true) errors.push("ageConfirmed");

  const src = typeof body.source === "string" ? body.source.trim() : "";
  const source = SOURCE_RE.test(src) ? src.toLowerCase() : "";

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { name, contactMethod, contact, attendingAs, foundUs, source } };
}
