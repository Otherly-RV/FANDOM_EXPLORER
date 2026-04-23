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
  type Node = { name: string; children: Node[] };
  const rootNode: Node = { name: root, children: [] };
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
      const node: Node = { name: r.category, children: [] };
      parent.children.push(node);
      byName.set(r.category, node);
      nextFrontier.push(r.category);
    }
    frontier = nextFrontier;
  }

  return NextResponse.json({ origin, root, depth, tree: rootNode });
}
