// app/api/admin/migrate/route.ts
// One-shot schema migration runnable from Vercel prod.
// Protected by MIGRATE_TOKEN env var. Idempotent (all statements use IF NOT EXISTS).
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-migrate-token");
  const expected = process.env.MIGRATE_TOKEN;
  if (!expected)
    return NextResponse.json(
      { error: "MIGRATE_TOKEN env var not set on server" },
      { status: 500 }
    );
  if (token !== expected)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl)
    return NextResponse.json(
      { error: "DATABASE_URL not set" },
      { status: 500 }
    );
  const db = neon(dbUrl);

  // Read schema.sql at request time.
  let schema: string;
  try {
    schema = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
  } catch (e: any) {
    return NextResponse.json(
      { error: `cannot read schema.sql: ${e.message}` },
      { status: 500 }
    );
  }

  // Strip SQL line comments, then split on semicolons. Skip empty or comment-only chunks.
  const stripped = schema
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  const stmts = stripped
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const applied: string[] = [];
  const errors: { stmt: string; error: string }[] = [];
  for (const s of stmts) {
    try {
      // neon's raw query method.
      await (db as any).query(s);
      applied.push(s.split("\n")[0].slice(0, 80));
    } catch (e: any) {
      errors.push({ stmt: s.split("\n")[0].slice(0, 80), error: String(e.message || e) });
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    applied: applied.length,
    errors,
    preview: applied.slice(0, 40),
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
