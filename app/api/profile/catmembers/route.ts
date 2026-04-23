// app/api/profile/catmembers/route.ts
// GET ?origin=...&title=Category:Foo&limit=200
//   -> Direct members of a category: subcategories first, then articles.
//      Returns the SAME shape as /api/profile/links so the WebmapNode UI can
//      render both uniformly: { title, total, sections: { "Subcategories": [..],
//      "Pages": [..] } }.
import { NextRequest, NextResponse } from "next/server";
import { categoryMembers, parseFandomOrigin } from "@/lib/mw";

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
  const limit = Math.max(
    5,
    Math.min(500, Number(req.nextUrl.searchParams.get("limit") || 200))
  );

  const members = await categoryMembers(origin, title, "page|subcat", limit);
  const subcats: string[] = [];
  const pages: string[] = [];
  for (const m of members) {
    if (m.ns === 14) subcats.push(String(m.title)); // keep "Category:..." prefix
    else if (m.ns === 0) pages.push(String(m.title));
  }

  const sections: Record<string, string[]> = {};
  if (subcats.length) sections["Subcategories"] = subcats;
  if (pages.length) sections["Pages"] = pages;

  return NextResponse.json({
    origin,
    title,
    total: subcats.length + pages.length,
    sections,
  });
}
