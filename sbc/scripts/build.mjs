// Builds the folder that gets published (dist/): only the website and the editor — never the
// database files, tests or scripts. Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment
// (the host's build settings); if they are missing it keeps whatever config.js already says.
//   npm run build
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'support.js', 'content.js', 'config.js', '_headers']) cpSync(join(root, f), join(out, f));
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'admin'), join(out, 'admin'), { recursive: true });

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key } = process.env;
if (url && key) {
  if (/service_role/i.test(key) || key.startsWith('sb_secret_')) { console.error('That is the SECRET key. Use the public anon / publishable key.'); process.exit(1); }
  writeFileSync(join(out, 'config.js'), `window.SBC_CONFIG = ${JSON.stringify({ supabaseUrl: url.replace(/\/+$/, ''), anonKey: key })};\n`);
  console.log('Built dist/ connected to', url);
} else {
  console.log('Built dist/ using config.js as it is.' + (/supabaseUrl: ''/.test(readFileSync(join(out, 'config.js'), 'utf8')) ? ' (Not connected to a backend: the site will show its built-in content.)' : ''));
}
