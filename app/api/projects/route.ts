// app/api/projects/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await sql`
    SELECT id, name, root_url, node_count, created_at
    FROM projects
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, rootUrl, nodes = [], edges = [] } = body || {};
  if (!name || !rootUrl) {
    return NextResponse.json({ error: "name and rootUrl required" }, { status: 400 });
  }
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return NextResponse.json({ error: "nodes and edges must be arrays" }, { status: 400 });
  }
  const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  await sql`
    INSERT INTO projects (id, name, root_url, node_count)
    VALUES (${id}, ${name}, ${rootUrl}, ${nodes.length})
  `;

  // Batch-insert pages
  for (const n of nodes) {
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
      ON CONFLICT (project_id, url) DO NOTHING
    `;
  }
  for (const e of edges) {
    await sql`
      INSERT INTO edges (project_id, src_url, dst_url)
      VALUES (${id}, ${e.src}, ${e.dst})
      ON CONFLICT DO NOTHING
    `;
  }

  return NextResponse.json({ id });
}
