// Applies supabase/migrations/*.sql in order, once each.
// Usage: npm run db:migrate
//
// Tracks what has run in a small `_migrations` table, so running it again is safe.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env.local (Supabase → Connect → Session pooler).");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, onnotice: () => {} });
const dir = path.resolve("supabase/migrations");

try {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table _migrations enable row level security`;
  const applied = new Set((await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file})`;
    });
    console.log(`✓ applied ${file}`);
    ran++;
  }
  console.log(ran ? `Done — ${ran} migration(s) applied.` : "Database already up to date.");
} finally {
  await sql.end();
}
