// lib/db.ts
import { neon } from "@neondatabase/serverless";

// Lazy: don't construct a client at module load (build time) when DATABASE_URL
// may be unset. Only connect at actual request time.
type SqlFn = ReturnType<typeof neon>;
let _sql: SqlFn | null = null;

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
