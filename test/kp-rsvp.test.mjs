import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler from "../netlify/functions/kp-rsvp.mjs";
import { validateSubmission } from "../netlify/functions/lib/validate.mjs";
import { sendEmail } from "../netlify/functions/lib/notify-email.mjs";
import { sendWhatsApp } from "../netlify/functions/lib/notify-whatsapp.mjs";
import { buildEmail, buildWhatsAppText } from "../netlify/functions/lib/format.mjs";
import { _reset } from "../netlify/functions/lib/ratelimit.mjs";

const ENV = {
  RESEND_API_KEY: "re_SECRET", KP_NOTIFICATION_EMAIL: "admin-secret@example.org", KP_FROM_EMAIL: "KP <rsvp@example.org>",
  WHATSAPP_ACCESS_TOKEN: "WA_TOKEN_SECRET", WHATSAPP_PHONE_NUMBER_ID: "123456", KP_ADMIN_WHATSAPP_NUMBER: "+1 (416) 555-0100",
  WHATSAPP_TEMPLATE_NAME: "kp_new_rsvp", WHATSAPP_TEMPLATE_LANGUAGE: "en",
};
const good = () => ({ name: "John", age: 34, email: "John@Example.com", guestType: "single_man", event: "halloween", fetlife: "", foundVia: "sexshow", message: "Hi", ageConfirmed: true, website: "", source: "sexshow" });
const req = (body, extra = {}) => new Request("https://kingpenthouse.com/api/kp-rsvp", { method: "POST", headers: { "content-type": "application/json", origin: "https://kingpenthouse.com" }, body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
const ok = async () => {};
const boom = (m) => async () => { throw new Error(m); };
const run = (body, deps) => { _reset(); return handler(req(body), { ip: "1.1.1.1" }, { env: ENV, sendEmail: ok, sendWhatsApp: ok, ...deps }); };

test("valid submission succeeds with generic body", async () => {
  const r = await run(good());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

for (const [label, patch] of [
  ["age 18", { age: 18 }], ["age string junk", { age: "abc" }], ["age missing", { age: undefined }], ["bad email", { email: "nope" }],
  ["no name", { name: "  " }], ["bad guest", { guestType: "x" }], ["bad event", { event: "x" }], ["bad found", { foundVia: "x" }],
  ["unchecked", { ageConfirmed: false }], ["checked as string", { ageConfirmed: "true" }], ["bad fetlife", { fetlife: "bad/name!" }],
]) {
  test(`rejects ${label}`, async () => {
    let sent = 0;
    const r = await run({ ...good(), ...patch }, { sendEmail: async () => { sent++; }, sendWhatsApp: async () => { sent++; } });
    assert.equal(r.status, 400);
    assert.equal(sent, 0);
  });
}

test("honeypot fakes success and sends nothing", async () => {
  let sent = 0;
  const r = await run({ ...good(), website: "http://spam" }, { sendEmail: async () => { sent++; }, sendWhatsApp: async () => { sent++; } });
  assert.equal(r.status, 200);
  assert.equal(sent, 0);
});

test("invalid JSON, oversized body, wrong method, foreign origin", async () => {
  _reset();
  assert.equal((await handler(req("{nope"), { ip: "2.2.2.2" }, { env: ENV })).status, 400);
  assert.equal((await handler(req("x".repeat(9000)), { ip: "2.2.2.3" }, { env: ENV })).status, 413);
  assert.equal((await handler(new Request("https://kingpenthouse.com/api/kp-rsvp", { method: "PUT" }), {}, { env: ENV })).status, 405);
  const evil = new Request("https://kingpenthouse.com/api/kp-rsvp", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal((await handler(evil, { ip: "2.2.2.4" }, { env: ENV })).status, 403);
});

test("rate limit kicks in", async () => {
  _reset();
  let last;
  for (let i = 0; i < 7; i++) last = await handler(req(good()), { ip: "9.9.9.9" }, { env: ENV, sendEmail: ok, sendWhatsApp: ok });
  assert.equal(last.status, 429);
});

test("source param is whitelisted", () => {
  assert.equal(validateSubmission({ ...good(), source: "sexshow" }).data.source, "sexshow");
  assert.equal(validateSubmission({ ...good(), source: "<b>evil</b>" }).data.source, "");
});

test("sanitizes injection / header injection", () => {
  const d = validateSubmission({ ...good(), name: "Bob\r\nBcc: x@y.z <script>alert(1)</script>", message: "<img src=x onerror=1>\n\n\n\nhi" }).data;
  assert.ok(!/[<>\r\n]/.test(d.name));
  assert.ok(!/[<>]/.test(d.message));
  const { subject, html } = buildEmail(d);
  assert.ok(!/[\r\n]/.test(subject));
  assert.ok(!html.includes("<script"));
});

// ---- failure isolation ----
test("email ok, whatsapp fails -> still accepted, both attempted", async () => {
  let emailCalled = false;
  const r = await run(good(), { sendEmail: async () => { emailCalled = true; }, sendWhatsApp: boom("meta 401 SECRET") });
  assert.equal(r.status, 200);
  assert.ok(emailCalled);
  assert.ok(!JSON.stringify(await r.json()).includes("SECRET"));
});
test("whatsapp ok, email fails -> still accepted", async () => {
  let waCalled = false;
  const r = await run(good(), { sendEmail: boom("resend 403 SECRET"), sendWhatsApp: async () => { waCalled = true; } });
  assert.equal(r.status, 200);
  assert.ok(waCalled);
});
test("both fail -> generic error, no leakage, serious log", async () => {
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(" "));
  const r = await run(good(), { sendEmail: boom("resend SECRET"), sendWhatsApp: boom("meta SECRET") });
  console.error = orig;
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(!/SECRET|resend|meta|whatsapp/i.test(text));
  assert.ok(errs.some((e) => e.includes("CRITICAL")));
});

// ---- turnstile ----
test("turnstile enforced when secret set", async () => {
  const env = { ...ENV, TURNSTILE_SECRET_KEY: "s", TURNSTILE_SITE_KEY: "pub" };
  _reset();
  const bad = await handler(req(good()), { ip: "3.3.3.3" }, { env, sendEmail: ok, sendWhatsApp: ok, verifyTurnstile: async () => false });
  assert.equal(bad.status, 400);
  const good2 = await handler(req({ ...good(), turnstileToken: "t" }), { ip: "3.3.3.4" }, { env, sendEmail: ok, sendWhatsApp: ok, verifyTurnstile: async () => true });
  assert.equal(good2.status, 200);
  const cfg = await handler(new Request("https://kingpenthouse.com/api/kp-rsvp"), {}, { env });
  assert.deepEqual(await cfg.json(), { turnstileSiteKey: "pub" });
});
test("GET config never leaks secrets", async () => {
  const cfg = await handler(new Request("https://kingpenthouse.com/api/kp-rsvp"), {}, { env: ENV });
  const t = await cfg.text();
  for (const v of Object.values(ENV)) assert.ok(!t.includes(v));
});

// ---- provider request shapes ----
test("resend request", async () => {
  let call;
  await sendEmail(validateSubmission(good()).data, ENV, async (url, init) => { call = { url, init }; return new Response("{}", { status: 200 }); });
  const body = JSON.parse(call.init.body);
  assert.equal(call.url, "https://api.resend.com/emails");
  assert.equal(call.init.headers.Authorization, "Bearer re_SECRET");
  assert.deepEqual(body.to, ["admin-secret@example.org"]);
  assert.equal(body.subject, "NEW KP RSVP: Halloween | Single Male | John");
  assert.match(body.text, /FOUND KP THROUGH:\nToronto Sex Show/);
  assert.match(body.text, /TRACKING SOURCE:\nsexshow/);
});
test("whatsapp template request", async () => {
  let call;
  await sendWhatsApp(validateSubmission(good()).data, ENV, async (url, init) => { call = { url, init }; return new Response("{}", { status: 200 }); });
  const body = JSON.parse(call.init.body);
  assert.match(call.url, /graph\.facebook\.com\/v[\d.]+\/123456\/messages$/);
  assert.equal(body.to, "14165550100");
  assert.equal(body.type, "template");
  assert.equal(body.template.name, "kp_new_rsvp");
  const p = body.template.components[0].parameters.map((x) => x.text);
  assert.equal(p[0], "Halloween"); assert.equal(p[1], "John"); assert.equal(p[3], "Single Male"); assert.equal(p[6], "Toronto Sex Show"); assert.equal(p[7], "sexshow");
  assert.ok(p.every((x) => !/[\n\t]/.test(x) && x.length));
});
test("whatsapp falls back to text when no template; custom param order", async () => {
  let body;
  const f = async (u, i) => { body = JSON.parse(i.body); return new Response("{}"); };
  const d = validateSubmission(good()).data;
  await sendWhatsApp(d, { ...ENV, WHATSAPP_TEMPLATE_NAME: "" }, f);
  assert.equal(body.type, "text");
  assert.match(body.text.body, /👑 KING PENTHOUSE\nNEW RSVP\n\n🎃 Halloween - October 31/);
  await sendWhatsApp(d, { ...ENV, WHATSAPP_TEMPLATE_PARAMS: "name,found" }, f);
  assert.deepEqual(body.template.components[0].parameters.map((x) => x.text), ["John", "Toronto Sex Show"]);
});
test("provider HTTP errors and missing config throw", async () => {
  const d = validateSubmission(good()).data;
  await assert.rejects(sendEmail(d, ENV, async () => new Response("bad", { status: 401 })));
  await assert.rejects(sendWhatsApp(d, ENV, async () => new Response("bad", { status: 400 })));
  await assert.rejects(sendEmail(d, {}));
  await assert.rejects(sendWhatsApp(d, {}));
});

// ---- no private data in anything served to browsers ----
test("public files contain no secrets, phone numbers or wa.me", () => {
  for (const f of ["kp.html", "kp.js", "kp.css"]) {
    const t = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/wa\.me|api\.whatsapp|tel:|mailto:|WHATSAPP|RESEND|KP_ADMIN|KP_NOTIFICATION|\+?\d{3}[-. )]+\d{3}[-. ]\d{4}/i.test(t), f);
  }
});
