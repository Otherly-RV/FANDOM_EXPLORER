// app/api/profile/links/route.ts
// GET ?origin=...&title=Main_Page&limit=60
//   -> returns the outbound wiki-links of `title` (mainspace only), in the
//      order they appear on the page, grouped under the nearest preceding
//      heading. Used by the profiler panel's webmap view to walk the real
//      hypertext structure of a wiki interactively.
import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { mwGet, parseFandomOrigin, parsePage } from "@/lib/mw";

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
    Math.min(500, Number(req.nextUrl.searchParams.get("limit") || 80))
  );

  // Prefer HTML parse so we get document order + section headings.
  const parsed = await parsePage(origin, title, ["text"]);
  let links: { title: string; section: string; position: number }[] = [];
  if (parsed?.text) {
    links = extractLinksFromHtml(parsed.text);
  }
  // Fallback: if HTML parse returned nothing (rare), hit prop=links directly.
  if (links.length === 0) {
    try {
      const j = await mwGet<any>(origin, {
        action: "query",
        prop: "links",
        titles: title,
        pllimit: "max",
        plnamespace: 0,
      });
      const page = j.query?.pages?.[0];
      const arr = page?.links ?? [];
      let pos = 0;
      links = arr.map((l: any) => ({
        title: String(l.title || "").replace(/_/g, " "),
        section: "",
        position: pos++,
      }));
    } catch {
      /* ignore */
    }
  }

  // De-dupe (first occurrence wins), drop self-links, apply limit.
  const seen = new Set<string>();
  const out: { title: string; section: string; position: number }[] = [];
  for (const l of links) {
    const key = l.title;
    if (!key) continue;
    if (key === title) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= limit) break;
  }

  // Group by section for the UI.
  const grouped: Record<string, string[]> = {};
  for (const l of out) {
    const s = l.section || "";
    (grouped[s] ??= []).push(l.title);
  }

  return NextResponse.json({
    origin,
    title,
    total: out.length,
    sections: grouped,
  });
}

// Walk the HTML body and yield links + the nearest preceding heading.
// Drops categories, files, templates, special, help, user, portal, and
// external links. Strips fragments + query strings.
function extractLinksFromHtml(html: string) {
  const $ = cheerio.load(html);
  const out: { title: string; section: string; position: number }[] = [];
  let section = "";
  let pos = 0;
  // cheerio iterates in document order for find() on the body subtree.
  $("#mw-content-text, body")
    .first()
    .find("h1, h2, h3, h4, a")
    .each((_i, el) => {
      const tag = (el as any).tagName?.toLowerCase?.();
      if (!tag) return;
      if (/^h[1-4]$/.test(tag)) {
        const t = $(el).text().replace(/\[edit\]/gi, "").trim();
        if (t) section = t;
        return;
      }
      if (tag === "a") {
        const href = $(el).attr("href") || "";
        const m = href.match(/^\/wiki\/([^?#]+)/);
        if (!m) return;
        const target = decodeURIComponent(m[1]).replace(/_/g, " ");
        if (!target) return;
        if (
          /^(Category|File|Special|Help|Template|User|Portal|MediaWiki|Talk|User_talk):/i.test(
            target
          )
        )
          return;
        out.push({ title: target, section, position: pos++ });
      }
    });
  return out;
}
