// app/api/profile/hubs/route.ts
// GET ?origin=... -> editorial hub tree (from MediaWiki:Wiki-navigation + Main Page)
// Grouped as: { hub_source: { section: [link_title, ...] } }
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const originRaw = req.nextUrl.searchParams.get("origin") || "";
  if (!originRaw)
    return NextResponse.json({ error: "origin required" }, { status: 400 });
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

  const rows = (await sql`
    SELECT hub_source, section, link_title, position
    FROM wiki_hubs WHERE origin = ${origin}
    ORDER BY hub_source, section, position
  `) as any[];

  const grouped: Record<string, Record<string, string[]>> = {};
  for (const r of rows) {
    grouped[r.hub_source] ??= {};
    grouped[r.hub_source][r.section || ""] ??= [];
    grouped[r.hub_source][r.section || ""].push(r.link_title);
  }
  return NextResponse.json({ origin, hubs: grouped, count: rows.length });
}
