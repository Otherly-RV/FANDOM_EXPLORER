// app/api/projects/[id]/append/route.ts
// Incremental append: upsert pages + edges into an existing project as the
// crawl progresses. Lets us autosave so a closed tab doesn't lose work.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  const edges = Array.isArray(body?.edges) ? body.edges : [];

  // Make sure the project exists before we touch its child rows.
  const proj = (await sql`SELECT id FROM projects WHERE id = ${id}`) as any[];
  if (!proj.length) return NextResponse.json({ error: "project not found" }, { status: 404 });

  for (const n of pages) {
    await sql`
      INSERT INTO pages (project_id, url, title, depth, parent_url, summary, sections, categories, links, infobox, key_facts, ai_provider, ai_model, error)
      VALUES (
        ${id}, ${n.url}, ${n.title}, ${n.depth}, ${n.parentUrl || null},
        ${n.summary || null},
        ${JSON.stringify(n.sections || [])}::jsonb,
        ${JSON.stringify(n.categories || [])}::jsonb,
        ${JSON.stringify(n.links || [])}::jsonb,
        ${n.infobox ? JSON.stringify(n.infobox) : null}::jsonb,
        ${n.keyFacts ? JSON.stringify(n.keyFacts) : null}::jsonb,
        ${n.aiProvider || null},
        ${n.aiModel || null},
        ${!!n.error}
      )
      ON CONFLICT (project_id, url) DO UPDATE SET
        title       = EXCLUDED.title,
        depth       = EXCLUDED.depth,
        parent_url  = COALESCE(pages.parent_url, EXCLUDED.parent_url),
        summary     = EXCLUDED.summary,
        sections    = EXCLUDED.sections,
        categories  = EXCLUDED.categories,
        links       = EXCLUDED.links,
        infobox     = EXCLUDED.infobox,
        key_facts   = EXCLUDED.key_facts,
        ai_provider = EXCLUDED.ai_provider,
        ai_model    = EXCLUDED.ai_model,
        error       = EXCLUDED.error
    `;
  }
  for (const e of edges) {
    await sql`
      INSERT INTO edges (project_id, src_url, dst_url)
      VALUES (${id}, ${e.src}, ${e.dst})
      ON CONFLICT DO NOTHING
    `;
  }
  // Keep the denormalized counter in sync.
  await sql`
    UPDATE projects
    SET node_count = (SELECT COUNT(*) FROM pages WHERE project_id = ${id})
    WHERE id = ${id}
  `;
  return NextResponse.json({ ok: true });
}
