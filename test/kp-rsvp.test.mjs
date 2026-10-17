import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../netlify/functions/kp-rsvp.mjs";
import { validateSubmission } from "../netlify/functions/lib/validate.mjs";
import { sendEmail } from "../netlify/functions/lib/notify-email.mjs";
import { sendWhatsApp } from "../netlify/functions/lib/notify-whatsapp.mjs";
import { buildEmail } from "../netlify/functions/lib/format.mjs";
import { _reset } from "../netlify/functions/lib/ratelimit.mjs";

const ENV = {
  RESEND_API_KEY: "re_SECRET", KP_NOTIFICATION_EMAIL: "admin-secret@example.org", KP_FROM_EMAIL: "KP <rsvp@example.org>",
  WHATSAPP_ACCESS_TOKEN: "WA_TOKEN_SECRET", WHATSAPP_PHONE_NUMBER_ID: "123456", KP_ADMIN_WHATSAPP_NUMBER: "+1 (416) 555-0100",
  WHATSAPP_TEMPLATE_NAME: "kp_new_rsvp", WHATSAPP_TEMPLATE_LANGUAGE: "en",
};
const good = () => ({ name: "John", contactMethod: "Email", contact: "John@Example.com", attendingAs: "Single man", foundUs: "Toronto Sex Show", source: "sexshow", ageConfirmed: true, company: "" });
const req = (body, headers = {}) => new Request("https://kingpenthouse.com/.netlify/functions/kp-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://kingpenthouse.com", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ok = async () => {};
const boom = (m) => async () => { throw new Error(m); };
const run = (body, deps) => { _reset(); return handler(req(body), { ip: "1.1.1.1" }, { env: ENV, sendEmail: ok, sendWhatsApp: ok, ...deps }); };

test("valid submission succeeds with generic body", async () => {
  const r = await run(good());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});
test("valid WhatsApp contact and Other-with-text accepted", async () => {
  assert.equal((await run({ ...good(), contactMethod: "WhatsApp", contact: "+1 416 555 1234", foundUs: "Other: a friend" })).status, 200);
});

for (const [label, patch] of [
  ["no name", { name: "  " }], ["bad method", { contactMethod: "SMS" }], ["bad email", { contact: "nope" }],
  ["short phone", { contactMethod: "WhatsApp", contact: "12345" }], ["letters as phone", { contactMethod: "WhatsApp", contact: "abcdefghijkl" }],
  ["bad attendingAs", { attendingAs: "Robot" }], ["bad foundUs", { foundUs: "TikTok" }], ["Other without text", { foundUs: "Other:  " }],
  ["age not confirmed", { ageConfirmed: false }], ["age as string", { ageConfirmed: "true" }], ["age missing", { ageConfirmed: undefined }],
]) {
  test(`rejects ${label}`, async () => {
    let sent = 0;
    const r = await run({ ...good(), ...patch }, { sendEmail: async () => { sent++; }, sendWhatsApp: async () => { sent++; } });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false });
    assert.equal(sent, 0);
  });
}

test("honeypot fakes success and sends nothing", async () => {
  let sent = 0;
  const r = await run({ ...good(), company: "spam" }, { sendEmail: async () => { sent++; }, sendWhatsApp: async () => { sent++; } });
  assert.equal(r.status, 200);
  assert.equal(sent, 0);
});

test("bad JSON, oversize, wrong method, foreign origin", async () => {
  _reset();
  assert.equal((await handler(req("{nope"), { ip: "2.2.2.2" }, { env: ENV })).status, 400);
  assert.equal((await handler(req("x".repeat(9000)), { ip: "2.2.2.3" }, { env: ENV })).status, 413);
  assert.equal((await handler(new Request("https://kingpenthouse.com/x", { method: "GET" }), {}, { env: ENV })).status, 405);
  assert.equal((await handler(req("{}", { origin: "https://evil.example" }), { ip: "2.2.2.4" }, { env: ENV })).status, 403);
});

test("rate limit: 6th request from one IP is 429", async () => {
  _reset();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await handler(req(good()), { ip: "9.9.9.9" }, { env: ENV, sendEmail: ok, sendWhatsApp: ok })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
});

test("source: valid kept lower-cased, script dropped", () => {
  assert.equal(validateSubmission({ ...good(), source: "SexShow" }).data.source, "sexshow");
  assert.equal(validateSubmission({ ...good(), source: "<script>" }).data.source, "");
});

test("sanitizes injection and header injection", () => {
  const d = validateSubmission({ ...good(), name: "Bob\r\nBcc: x@y.z <script>alert(1)</script>", foundUs: "Other: <img onerror=1>\nx" }).data;
  assert.ok(!/[<>\r\n]/.test(d.name + d.foundUs));
  const { subject, html } = buildEmail(d);
  assert.ok(!/[\r\n]/.test(subject));
  assert.ok(!html.includes("<script") && !html.includes("<img"));
});

// ---- failure isolation ----
test("email ok, WhatsApp fails -> accepted, both attempted, no leak", async () => {
  let emailCalled = false;
  const r = await run(good(), { sendEmail: async () => { emailCalled = true; }, sendWhatsApp: boom("meta 401 SECRET") });
  assert.equal(r.status, 200);
  assert.ok(emailCalled);
  assert.ok(!(await r.text()).includes("SECRET"));
});
test("WhatsApp ok, email fails -> accepted", async () => {
  let waCalled = false;
  const r = await run(good(), { sendEmail: boom("resend 403 SECRET"), sendWhatsApp: async () => { waCalled = true; } });
  assert.equal(r.status, 200);
  assert.ok(waCalled);
});
test("both fail -> generic error and serious log", async () => {
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(" "));
  const r = await run(good(), { sendEmail: boom("resend SECRET"), sendWhatsApp: boom("meta SECRET") });
  console.error = orig;
  assert.equal(r.status, 502);
  assert.equal(await r.text(), '{"ok":false}');
  assert.ok(errs.some((e) => e.includes("CRITICAL")));
});

// ---- provider request shapes ----
test("Resend request", async () => {
  let call;
  await sendEmail(validateSubmission(good()).data, ENV, async (url, init) => { call = { url, init }; return new Response("{}"); });
  const body = JSON.parse(call.init.body);
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.headers.Authorization, "Bearer re_SECRET");
  assert.deepEqual(body.to, ["admin-secret@example.org"]);
  assert.equal(body.reply_to, "john@example.com");
  assert.equal(body.subject, "NEW KP RSVP: Single man | John | Toronto Sex Show");
  assert.match(body.text, /QR SOURCE:\nsexshow/);
  assert.match(body.text, /SUBMITTED:\n.* America\/Toronto/);
});
test("WhatsApp template request (7 variables)", async () => {
  let call;
  await sendWhatsApp(validateSubmission(good()).data, ENV, async (url, init) => { call = { url, init }; return new Response("{}"); });
  const body = JSON.parse(call.init.body);
  assert.match(call.url, /graph\.facebook\.com\/v[\d.]+\/123456\/messages$/);
  assert.equal(body.to, "14165550100");
  assert.equal(body.template.name, "kp_new_rsvp");
  const p = body.template.components[0].parameters.map((x) => x.text);
  assert.equal(p.length, 7);
  assert.deepEqual(p.slice(0, 6), ["John", "Single man", "Email", "john@example.com", "Toronto Sex Show", "sexshow"]);
  assert.ok(p.every((x) => !/[\n\t]/.test(x) && x));
});
test("WhatsApp text fallback and custom param order", async () => {
  let body;
  const f = async (u, i) => { body = JSON.parse(i.body); return new Response("{}"); };
  const d = validateSubmission(good()).data;
  await sendWhatsApp(d, { ...ENV, WHATSAPP_TEMPLATE_NAME: "" }, f);
  assert.equal(body.type, "text");
  assert.match(body.text.body, /^👑 KING PENTHOUSE\nNEW RSVP/);
  await sendWhatsApp(d, { ...ENV, WHATSAPP_TEMPLATE_PARAMS: "found,name" }, f);
  assert.deepEqual(body.template.components[0].parameters.map((x) => x.text), ["Toronto Sex Show", "John"]);
});
test("provider HTTP errors and missing config throw", async () => {
  const d = validateSubmission(good()).data;
  await assert.rejects(sendEmail(d, ENV, async () => new Response("bad", { status: 401 })));
  await assert.rejects(sendWhatsApp(d, ENV, async () => new Response("bad", { status: 400 })));
  await assert.rejects(sendEmail(d, {}));
  await assert.rejects(sendWhatsApp(d, {}));
});

// ---- nothing private in browser-served files ----
test("kp.html has no secrets, phone numbers, wa.me or env names", () => {
  const t = readFileSync(new URL("../kp.html", import.meta.url), "utf8");
  assert.ok(!/wa\.me|api\.whatsapp|tel:|mailto:|RESEND|WHATSAPP_|KP_ADMIN|KP_NOTIFICATION|\+?\d{3}[-. )]+\d{3}[-. ]\d{4}/i.test(t));
  assert.match(t, /\/\.netlify\/functions\/kp-rsvp/);
});
