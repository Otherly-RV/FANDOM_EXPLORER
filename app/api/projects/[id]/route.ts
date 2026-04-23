// app/api/projects/[id]/route.ts
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const proj = (await sql`SELECT * FROM projects WHERE id = ${id}`) as any[];
  if (!proj.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  const pages = (await sql`SELECT * FROM pages WHERE project_id = ${id}`) as any[];
  const edges = (await sql`SELECT src_url, dst_url FROM edges WHERE project_id = ${id}`) as any[];
  return NextResponse.json({
    project: proj[0],
    nodes: pages.map((p: any) => ({
      url: p.url,
      title: p.title,
      depth: p.depth,
      parentUrl: p.parent_url,
      summary: p.summary,
      sections: p.sections,
      categories: p.categories,
      links: p.links,
      infobox: p.infobox,
      keyFacts: p.key_facts,
      aiProvider: p.ai_provider,
      aiModel: p.ai_model,
      error: p.error,
    })),
    edges: edges.map((e: any) => ({ src: e.src_url, dst: e.dst_url })),
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  await sql`DELETE FROM projects WHERE id = ${id}`;
  return NextResponse.json({ ok: true });
}
