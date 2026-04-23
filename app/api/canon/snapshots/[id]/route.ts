// app/api/canon/snapshots/[id]/route.ts
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const rows = await sql`SELECT * FROM canon_snapshots WHERE id = ${id}` as any[];
    if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    const r = rows[0];
    return NextResponse.json({
      id: r.id,
      name: r.name,
      origin: r.origin,
      sitename: r.sitename,
      articles: r.articles,
      groups: r.groups_json,
      explanation: r.explanation,
      created_at: r.created_at,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await sql`DELETE FROM canon_snapshots WHERE id = ${id}`;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
