// lib/db.ts
import { neon, Client } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Lazy: don't construct a client at module load (build time) when DATABASE_URL
// may be unset. Only connect at actual request time.
type SqlFn = ReturnType<typeof neon>;
let _sql: SqlFn | null = null;
let _migratePromise: Promise<void> | null = null;

function getSql(): SqlFn {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  _sql = neon(url);
  return _sql;
}

// Tagged-template proxy so call sites keep the sql`...` syntax.
export const sql: SqlFn = ((strings: TemplateStringsArray, ...values: any[]) =>
  (getSql() as any)(strings, ...values)) as unknown as SqlFn;

// Auto-migrate on first call to ensureSchema. Idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
// Memoized per server instance so it only runs once.
export function ensureSchema(): Promise<void> {
  if (_migratePromise) return _migratePromise;
  _migratePromise = (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    let schema: string;
    try {
      schema = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
    } catch {
      return;
    }
    const stripped = schema
      .split(/\r?\n/)
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    const stmts = stripped
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const client = new Client(url);
    try {
      await client.connect();
      for (const stmt of stmts) {
        try { await client.query(stmt); } catch { /* idempotent — ignore */ }
      }
    } finally {
      try { await client.end(); } catch { /* */ }
    }
  })();
  return _migratePromise;
}

