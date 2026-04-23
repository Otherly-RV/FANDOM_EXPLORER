// app/api/profile/route.ts
// GET ?origin=...  -> live site info (sitename, mainpage, lang). No DB, no job.
import { NextRequest, NextResponse } from "next/server";
import { parseFandomOrigin, siteInfo } from "@/lib/mw";

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
  try {
    const info = await siteInfo(origin);
    return NextResponse.json({
      profile: {
        origin,
        sitename: info.sitename,
        mainpage: info.mainpage,
        lang: info.lang,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
