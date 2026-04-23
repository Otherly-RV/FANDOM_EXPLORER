// scripts/init-db.mjs
// Run: DATABASE_URL=... node scripts/init-db.mjs
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, "..", "lib", "schema.sql"), "utf8");

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// Split on semicolons but keep it simple — schema has no procedural blocks.
const stmts = schema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
for (const s of stmts) {
  // @ts-ignore - neon accepts raw SQL via tagged template; use .query
  await sql.query(s);
  console.log("OK:", s.split("\n")[0].slice(0, 70));
}
console.log("Schema ready.");
