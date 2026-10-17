import { buildWhatsAppFields, buildWhatsAppText } from "./format.mjs";

const GRAPH_VERSION = "v21.0";
// Template body variables {{1}}..{{7}}, in order. Override with WHATSAPP_TEMPLATE_PARAMS (comma list of field names).
const DEFAULT_PARAMS = ["name", "type", "method", "contact", "found", "source", "time"];

export async function sendWhatsApp(d, env, fetchImpl = fetch) {
  const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, KP_ADMIN_WHATSAPP_NUMBER } = env;
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !KP_ADMIN_WHATSAPP_NUMBER) {
    throw new Error("whatsapp not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / KP_ADMIN_WHATSAPP_NUMBER)");
  }
  const to = KP_ADMIN_WHATSAPP_NUMBER.replace(/\D/g, ""); // Cloud API wants digits only, no "+"
  const fields = buildWhatsAppFields(d);

  let payload;
  if (env.WHATSAPP_TEMPLATE_NAME) {
    const order = (env.WHATSAPP_TEMPLATE_PARAMS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const keys = order.length ? order : DEFAULT_PARAMS;
    payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: env.WHATSAPP_TEMPLATE_NAME,
        language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
        components: [
          {
            type: "body",
            parameters: keys.map((k) => ({ type: "text", text: fields[k] ?? "-" })),
          },
        ],
      },
    };
  } else {
    // Free-form text only delivers inside the 24h customer-service window.
    payload = { messaging_product: "whatsapp", to, type: "text", text: { body: buildWhatsAppText(d), preview_url: false } };
  }

  const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`whatsapp ${res.status}: ${detail}`);
  }
}
