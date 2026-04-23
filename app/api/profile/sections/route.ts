// app/api/profile/sections/route.ts
// GET ?origin=...&title=Street_Fighter_6
//   -> The page's table of contents as a nested tree:
//      [{ number: "2", label: "Gameplay", anchor: "Gameplay", children: [
//         { number: "2.1", label: "Drive Gauge", anchor: "Drive_Gauge", ... },
//         ...
//      ]}]
//   Source: MediaWiki action=parse&prop=sections (authoritative; same data the
//   wiki itself uses to render the TOC box).
import { NextRequest, NextResponse } from "next/server";
import { mwGet, parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TocNode = {
  number: string; // "2", "2.1", "2.3.1"
  label: string;
  anchor: string; // URL fragment
  level: number; // heading level (2=h2, 3=h3, ...)
  children: TocNode[];
};

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
  const title = (req.nextUrl.searchParams.get("title") || "").trim();
  if (!originRaw || !title)
    return NextResponse.json(
      { error: "origin and title required" },
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

  const j = await mwGet<any>(origin, {
    action: "parse",
    page: title,
    prop: "sections",
    redirects: 1,
  }).catch(() => null);

  const raw: any[] = j?.parse?.sections || [];
  // Each raw entry: { toclevel, level, line, number, anchor, ... }
  const tree = buildTree(raw);
  return NextResponse.json({
    origin,
    title: j?.parse?.title || title,
    total: raw.length,
    tree,
  });
}

function buildTree(rows: any[]): TocNode[] {
  const roots: TocNode[] = [];
  // Stack indexed by toclevel (1-based).
  const stack: TocNode[] = [];
  for (const r of rows) {
    const toclevel = Number(r.toclevel) || 1;
    const node: TocNode = {
      number: String(r.number || ""),
      label: String(r.line || "").replace(/<[^>]+>/g, "").trim(),
      anchor: String(r.anchor || ""),
      level: Number(r.level) || toclevel,
      children: [],
    };
    stack.length = toclevel - 1;
    if (toclevel === 1) {
      roots.push(node);
    } else {
      const parent = stack[toclevel - 2];
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    stack[toclevel - 1] = node;
  }
  return roots;
}
