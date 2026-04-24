// app/api/canon/snapshots/route.ts
// List + create Canon inventory snapshots.
// Pages live in canon_pages — POST only creates the metadata shell.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await sql`
      SELECT s.id, s.name, s.origin, s.sitename, s.articles,
             s.created_at, s.updated_at,
             jsonb_array_length(s.groups_json) AS group_count,
             (SELECT COUNT(*) FROM canon_pages WHERE snapshot_id = s.id) AS page_count
      FROM canon_snapshots s
      ORDER BY s.updated_at DESC
      LIMIT 200
    `;
    return NextResponse.json(rows);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// Create a new snapshot with group metadata only (no page bodies).
// Pages are appended later via /api/canon/snapshots/[id]/pages.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, origin, sitename, articles, groups, explanation } = body || {};
    if (!name || !origin || !Array.isArray(groups)) {
      return NextResponse.json({ error: "name, origin, groups required" }, { status: 400 });
    }
    // Strip `pages` from the groups blob — page bodies never go in the JSON column.
    const groupsMeta = groups.map((g: any) => {
      const { pages: _p, ...rest } = g || {};
      return rest;
    });
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await sql`
      INSERT INTO canon_snapshots
        (id, name, origin, sitename, articles, groups_json, explanation, updated_at)
      VALUES (
        ${id}, ${name}, ${origin}, ${sitename || null}, ${articles || 0},
        ${JSON.stringify(groupsMeta)}::jsonb,
        ${explanation || null}, now()
      )
    `;
    return NextResponse.json({ id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

