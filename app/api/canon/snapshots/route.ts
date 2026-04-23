// app/api/canon/snapshots/route.ts
// List + save Canon inventory snapshots.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await sql`
      SELECT id, name, origin, sitename, articles, created_at,
             jsonb_array_length(groups_json) AS group_count
      FROM canon_snapshots
      ORDER BY created_at DESC
      LIMIT 200
    `;
    return NextResponse.json(rows);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, origin, sitename, articles, groups, explanation } = body || {};
    if (!name || !origin || !Array.isArray(groups)) {
      return NextResponse.json({ error: "name, origin, groups required" }, { status: 400 });
    }
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await sql`
      INSERT INTO canon_snapshots (id, name, origin, sitename, articles, groups_json, explanation)
      VALUES (
        ${id}, ${name}, ${origin}, ${sitename || null}, ${articles || 0},
        ${JSON.stringify(groups)}::jsonb,
        ${explanation || null}
      )
    `;
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
