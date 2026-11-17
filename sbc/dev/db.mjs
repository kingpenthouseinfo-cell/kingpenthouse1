// Local Postgres (PGlite) with the real migrations applied. Used by the tests and the dev server.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createDb() {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, 'supabase/tests/stub_supabase.sql'), 'utf8'));
  const dir = join(root, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

export async function runMigrationsAgain(db) {
  const dir = join(root, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('_seed_content.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }
}

// Run SQL as a given API role (what PostgREST does): anon, or authenticated + a user id.
export async function asRole(db, role, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (userId) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role })]);
    return fn(tx);
  });
}
