// lib/fandom.ts
// Real structural data extracted from the Fandom MediaWiki API.
// No LLM is used for structure (links, categories, sections).
import * as cheerio from "cheerio";

export type Section = { heading: string; level: number; anchor: string };
export type PageData = {
  url: string;
  canonicalUrl: string;
  title: string;
  summary: string;         // real first paragraph from the wiki (plain text)
  sections: Section[];     // real section headings from MediaWiki TOC
  categories: string[];    // real categories assigned on the wiki
  links: string[];         // real outgoing article links (ns=0 only)
  infobox?: Record<string, string>;
};

export function parseFandomUrl(input: string): { origin: string; page: string } {
  const u = new URL(input);
  if (!u.hostname.endsWith("fandom.com")) {
    throw new Error("Not a fandom.com URL");
  }
  const m = u.pathname.match(/\/wiki\/(.+)$/);
  if (!m) throw new Error("URL must contain /wiki/<Page>");
  return { origin: u.origin, page: decodeURIComponent(m[1]) };
}

export function titleToUrl(origin: string, title: string): string {
  return `${origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export async function fetchFandomPage(rawUrl: string): Promise<PageData> {
  const { origin, page } = parseFandomUrl(rawUrl);

  // Primary: action=parse returns real links, categories, sections, HTML text.
  // redirects=1 follows wiki redirects so we always land on the canonical title.
  const api = new URL(`${origin}/api.php`);
  api.searchParams.set("action", "parse");
  api.searchParams.set("page", page);
  api.searchParams.set("prop", "text|links|categories|sections|displaytitle");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  api.searchParams.set("redirects", "1");

  const r = await fetch(api.toString(), {
    headers: { "User-Agent": "FandomExplorer/1.0 (+https://github.com/Otherly-RV/FANDOM_EXPLORER)" },
    // Cache on Vercel's edge for a short window to be polite to Fandom.
    next: { revalidate: 3600 },
  });
  if (!r.ok) throw new Error(`Fandom API ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.info || "MediaWiki error");
  const parse = j.parse;
  if (!parse) throw new Error("No parse result");

  const title: string = parse.title;
  const canonicalUrl = titleToUrl(origin, title);

  // Real outgoing article links — only namespace 0 (articles).
  // Exclude "missing" (redlinks) to avoid dead nodes in the graph.
  const links: string[] = Array.from(
    new Set<string>(
      (parse.links || [])
        .filter((l: any) => l.ns === 0 && l.exists !== false)
        .map((l: any) => String(l.title))
    )
  );

  // Real categories — MediaWiki returns internal sortkeys + display name in `category`.
  const categories: string[] = Array.from(
    new Set<string>((parse.categories || []).map((c: any) => String(c.category).replace(/_/g, " ")))
  ).filter((c) => !/^(Hidden|Tracking)/i.test(c));

  // Real sections from the wiki's own TOC.
  const sections: Section[] = (parse.sections || []).map((s: any) => ({
    heading: String(s.line).replace(/<[^>]+>/g, ""),
    level: Number(s.toclevel) || 1,
    anchor: String(s.anchor || ""),
  }));

  // Real first paragraph from the rendered HTML.
  const html: string = parse.text || "";
  const $ = cheerio.load(html);
  // Fandom wraps the intro before any <h2>. Grab first meaningful <p>.
  let summary = "";
  $("p").each((_i, el) => {
    if (summary) return;
    const txt = $(el).text().replace(/\[\d+\]/g, "").trim();
    if (txt.length > 40) summary = txt;
  });
  summary = summary.slice(0, 1200);

  // Extract infobox key/value pairs if present (real, from the rendered page).
  const infobox: Record<string, string> = {};
  $(".portable-infobox .pi-item.pi-data").each((_i, el) => {
    const k = $(el).find(".pi-data-label").text().trim();
    const v = $(el).find(".pi-data-value").text().trim();
    if (k && v) infobox[k] = v;
  });

  return {
    url: rawUrl,
    canonicalUrl,
    title,
    summary,
    sections,
    categories,
    links,
    infobox: Object.keys(infobox).length ? infobox : undefined,
  };
}
