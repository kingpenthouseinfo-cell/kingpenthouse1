// Writes config.js from environment variables (used by the host's build step).
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/write-config.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = process.env;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY first.'); process.exit(1); }
if (/service_role/i.test(key)) { console.error('That looks like the SECRET service key. Use the public "anon" key.'); process.exit(1); }
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.js'),
  `window.SBC_CONFIG = ${JSON.stringify({ supabaseUrl: url.replace(/\/+$/, ''), anonKey: key })};\n`);
console.log('Wrote config.js');
