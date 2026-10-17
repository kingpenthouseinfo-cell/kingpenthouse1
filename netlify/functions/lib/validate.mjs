// Server-side validation + sanitization for /kp submissions.
// Nothing here trusts the browser: every value is re-checked and normalised.

export const GUEST_TYPES = {
  single_woman: "Single Female",
  single_man: "Single Male",
  couple: "Couple",
  other: "Other",
};

export const EVENTS = {
  halloween: { label: "Halloween - October 31", short: "Halloween", emoji: "🎃" },
  saturday: { label: "Upcoming Saturday Party", short: "Saturday Party", emoji: "🥂" },
  future: { label: "Future King Penthouse Events", short: "Future Events", emoji: "👑" },
};

export const FOUND_VIA = {
  sexshow: "Toronto Sex Show",
  sugardaddys: "Sugar Daddy's",
  fetlife: "FetLife",
  friend: "Friend / Referral",
  flyer: "Flyer",
  social: "Social Media",
  web: "Google / Web",
  other: "Other",
};

// Whitelisted ?source= values (flyer / QR tracking). Anything else is dropped.
export const SOURCES = {
  sexshow: "sexshow",
  sugardaddys: "sugardaddys",
  flyer: "flyer",
  fetlife: "fetlife",
  instagram: "instagram",
  social: "social",
  friend: "friend",
  web: "web",
};

export const MIN_AGE = 19;
const MAX_AGE = 99;

// Control chars, bidi overrides, zero-width chars and line/paragraph separators.
const INVISIBLE_OR_CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

// Strip control chars (incl. CR/LF -> space for single-line fields), collapse whitespace.
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

// Multi-line text: keep newlines, drop other control chars and angle brackets.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_KEEP_NEWLINE, "")
    .replace(/[<>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const FETLIFE_RE = /^[A-Za-z0-9_.\- ]{1,40}$/;

/**
 * @returns {{ ok: true, data: object } | { ok: false, bot?: boolean, errors: string[] }}
 */
export function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body"] };
  }

  // Honeypot: real visitors never see/fill this. Caller silently fakes success.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: false, bot: true, errors: ["honeypot"] };
  }

  const errors = [];

  const name = cleanLine(body.name, 80);
  if (name.length < 1) errors.push("name");

  const ageRaw = typeof body.age === "number" ? body.age : Number(String(body.age ?? "").trim());
  const age = Number.isInteger(ageRaw) ? ageRaw : NaN;
  if (!(age >= MIN_AGE && age <= MAX_AGE)) errors.push("age");

  const email = cleanLine(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) errors.push("email");

  const guestKey = typeof body.guestType === "string" ? body.guestType : "";
  if (!Object.hasOwn(GUEST_TYPES, guestKey)) errors.push("guestType");

  const eventKey = typeof body.event === "string" ? body.event : "";
  if (!Object.hasOwn(EVENTS, eventKey)) errors.push("event");

  const foundKey = typeof body.foundVia === "string" ? body.foundVia : "";
  if (!Object.hasOwn(FOUND_VIA, foundKey)) errors.push("foundVia");

  let fetlife = cleanLine(body.fetlife, 40).replace(/^@/, "");
  if (fetlife && !FETLIFE_RE.test(fetlife)) errors.push("fetlife");

  const message = cleanText(body.message, 1000);

  if (body.ageConfirmed !== true) errors.push("ageConfirmed");

  const srcRaw = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";
  const source = Object.hasOwn(SOURCES, srcRaw) ? SOURCES[srcRaw] : "";

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name,
      age,
      email,
      guestType: GUEST_TYPES[guestKey],
      eventKey,
      event: EVENTS[eventKey].label,
      eventShort: EVENTS[eventKey].short,
      eventEmoji: EVENTS[eventKey].emoji,
      fetlife,
      foundVia: FOUND_VIA[foundKey],
      message,
      source, // "" when absent/invalid
    },
  };
}
