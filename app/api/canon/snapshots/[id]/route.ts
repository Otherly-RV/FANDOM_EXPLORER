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
    const pages = await sql`
      SELECT gid, title, url, template, fields, lead, sections
      FROM canon_pages
      WHERE snapshot_id = ${id}
      ORDER BY gid, title
    ` as any[];
    // Reconstruct groups with their pages attached.
    const groupsMeta: any[] = Array.isArray(r.groups_json) ? r.groups_json : [];
    const byGid = new Map<number, any[]>();
    for (const p of pages) {
      const arr = byGid.get(p.gid) || [];
      arr.push({
        gid: p.gid,
        title: p.title,
        url: p.url,
        template: p.template,
        fields: Array.isArray(p.fields) ? p.fields : [],
        lead: p.lead || "",
        sections: Array.isArray(p.sections) ? p.sections : [],
      });
      byGid.set(p.gid, arr);
    }
    const groups = groupsMeta.map((g) => ({
      ...g,
      pages: byGid.get(g.gid) || [],
      fetched: (byGid.get(g.gid) || []).length,
      done: true,
    }));
    return NextResponse.json({
      id: r.id,
      name: r.name,
      origin: r.origin,
      sitename: r.sitename,
      articles: r.articles,
      groups,
      explanation: r.explanation,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// Update snapshot metadata: group classification updates, explanation, name.
export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const { name, groups, explanation } = body || {};
    if (typeof name === "string") {
      await sql`UPDATE canon_snapshots SET name = ${name}, updated_at = now() WHERE id = ${id}`;
    }
    if (Array.isArray(groups)) {
      const groupsMeta = groups.map((g: any) => {
        const { pages: _p, ...rest } = g || {};
        return rest;
      });
      await sql`
        UPDATE canon_snapshots
        SET groups_json = ${JSON.stringify(groupsMeta)}::jsonb, updated_at = now()
        WHERE id = ${id}
      `;
    }
    if (typeof explanation === "string") {
      await sql`UPDATE canon_snapshots SET explanation = ${explanation}, updated_at = now() WHERE id = ${id}`;
    }
    return NextResponse.json({ ok: true });
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

