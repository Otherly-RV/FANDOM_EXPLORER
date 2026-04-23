// app/api/canon/pages/route.ts
//
// STAGE 2 — content fetcher. Called in chunks by the client.
// Request:  { origin, titles: string[] }   // batch of 10–30 titles
// Response: { pages: [{ title, url, template?, fields, lead, sections }, ...] }
//
// Each request runs well within the Vercel timeout. The client keeps issuing
// batches until every title is fetched, so total wiki size is unbounded.

import { NextRequest, NextResponse } from "next/server";
import { parseFandomOrigin, titleToUrl } from "@/lib/mw";
import { fetchPageContent } from "@/lib/wiki-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BATCH = 30;         // hard cap on titles per request
const CONCURRENCY = 6;

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const rawOrigin: string = body.origin || "";
  const titlesIn: string[] = Array.isArray(body.titles) ? body.titles : [];
  if (!titlesIn.length) return NextResponse.json({ pages: [] });

  let origin = "";
  try {
    origin = rawOrigin.includes("/wiki/")
      ? parseFandomOrigin(rawOrigin)
      : new URL(rawOrigin).origin;
  } catch {
    return NextResponse.json({ error: "bad origin" }, { status: 400 });
  }

  const titles = titlesIn.slice(0, MAX_BATCH).filter((t) => typeof t === "string" && t);
  const results: any[] = new Array(titles.length);

  let i = 0;
  async function worker() {
    while (i < titles.length) {
      const cur = i++;
      const t = titles[cur];
      try {
        const d = await fetchPageContent(origin, t);
        results[cur] = {
          title: t,
          url: titleToUrl(origin, t),
          template: d?.template,
          fields: d?.fields || [],
          lead: d?.lead || "",
          sections: d?.sections || [],
        };
      } catch (e: any) {
        results[cur] = {
          title: t,
          url: titleToUrl(origin, t),
          error: String(e?.message || e),
          fields: [],
          lead: "",
          sections: [],
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, titles.length) }, () => worker())
  );

  return NextResponse.json({ pages: results });
}
