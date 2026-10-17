// Cloudflare Turnstile verification. Enabled only when TURNSTILE_SECRET_KEY is set;
// once enabled it fails closed (missing/invalid token = rejected).
export function turnstileEnabled(env) {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(token, ip, env, fetchImpl = fetch) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set("remoteip", ip);
  const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`turnstile http ${res.status}`);
  const json = await res.json();
  return json.success === true;
}
