// Shared helpers for browser tests. The page loads React from unpkg; tests serve the identical
// packages from node_modules so they run offline and deterministically.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const nm = (p) => readFileSync(join(root, 'node_modules', p));

export async function routeCdn(context) {
  await context.route(/unpkg\.com\/react@18\.3\.1\//, (r) => r.fulfill({ contentType: 'application/javascript', body: nm('react/umd/react.production.min.js') }));
  await context.route(/unpkg\.com\/react-dom@18\.3\.1\//, (r) => r.fulfill({ contentType: 'application/javascript', body: nm('react-dom/umd/react-dom.production.min.js') }));
  await context.route(/unpkg\.com\/@babel\/standalone/, (r) => r.fulfill({ contentType: 'application/javascript', body: nm('@babel/standalone/babel.min.js') }));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
}

export function playwright() {
  // Playwright is installed globally in this environment; locally: npm i -D playwright
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch { return createRequire(process.env.NODE_PATH ? join(process.env.NODE_PATH, 'x.js') : import.meta.url)('playwright'); }
}
