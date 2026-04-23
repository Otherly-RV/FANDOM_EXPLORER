// app/api/profile/tree/route.ts
// GET ?origin=...&root=Browse&depth=2&limit=500
//   -> subtree of the category DAG rooted at `root`, pruned to `depth`.
//   -> Each node lists its direct subcategories + a sample of member pages.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

async function handle(req: NextRequest) {
  const originRaw = req.nextUrl.searchParams.get("origin") || "";
  const root = req.nextUrl.searchParams.get("root") || "";
  const depth = Math.max(
    0,
    Math.min(8, Number(req.nextUrl.searchParams.get("depth") || 2))
  );
  if (!originRaw || !root)
    return NextResponse.json(
      { error: "origin and root required" },
      { status: 400 }
    );
  let origin: string;
  try {
    origin = originRaw.includes("/wiki/")
      ? parseFandomOrigin(originRaw)
      : new URL(originRaw).origin;
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "bad origin" },
      { status: 400 }
    );
  }

  // Iteratively expand. Each level: fetch children of the current frontier.
  type Node = { name: string; pageCount: number; children: Node[] };
  const rootNode: Node = { name: root, pageCount: 0, children: [] };
  const byName = new Map<string, Node>([[root, rootNode]]);
  let frontier: string[] = [root];

  for (let d = 0; d < depth; d++) {
    if (!frontier.length) break;
    const rows = (await sql`
      SELECT DISTINCT category, parent FROM wiki_categories
      WHERE origin = ${origin} AND parent = ANY(${frontier}::text[])
    `) as any[];
    const nextFrontier: string[] = [];
    for (const r of rows) {
      const parent = byName.get(r.parent);
      if (!parent) continue;
      if (byName.has(r.category)) continue; // cycle guard
      const node: Node = { name: r.category, pageCount: 0, children: [] };
      parent.children.push(node);
      byName.set(r.category, node);
      nextFrontier.push(r.category);
    }
    frontier = nextFrontier;
  }

  // Page counts per category (direct members only).
  const names = [...byName.keys()];
  if (names.length) {
    const counts = (await sql`
      SELECT cat AS category, COUNT(*)::int AS c
      FROM wiki_pages,
           LATERAL jsonb_array_elements_text(categories) AS cat
      WHERE origin = ${origin} AND cat = ANY(${names}::text[])
      GROUP BY cat
    `) as any[];
    for (const row of counts) {
      const n = byName.get(row.category);
      if (n) n.pageCount = row.c;
    }
  }

  // Sort children by page count desc for readability.
  function sortRec(n: Node) {
    n.children.sort((a, b) => b.pageCount - a.pageCount);
    n.children.forEach(sortRec);
  }
  sortRec(rootNode);

  return NextResponse.json({ origin, root, depth, tree: rootNode });
}
