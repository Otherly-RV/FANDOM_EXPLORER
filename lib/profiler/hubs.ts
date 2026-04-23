// lib/profiler/hubs.ts
// Layer 3: parse the editorial surface of a wiki — the hand-curated way
// humans navigate canon. Sources:
//   - MediaWiki:Wiki-navigation  (top navbar)
//   - Main_Page                  (front-page portals/boxes)
//   - Portal:*                   (optional; probed opportunistically)
//
// Output is a flat list of (hub_source, section, link_title) rows, where
// "section" is the nearest heading above the link on the hub page.
import * as cheerio from "cheerio";
import { mwGet, parsePage, siteInfo } from "@/lib/mw";

export type HubLink = {
  hub_source: string;
  section: string;
  link_title: string;
  position: number;
};

// Parse MediaWiki:Wiki-navigation (wikitext-based).
// Syntax is an indented bullet list, e.g.:
//   *Films
//   **[[The Phantom Menace]]
//   **[[Attack of the Clones]]
async function parseWikiNavigation(origin: string): Promise<HubLink[]> {
  try {
    const j = await mwGet<any>(origin, {
      action: "parse",
      page: "MediaWiki:Wiki-navigation",
      prop: "wikitext",
      redirects: 1,
    });
    const text: string = j.parse?.wikitext || "";
    if (!text) return [];
    const out: HubLink[] = [];
    let currentSection = "";
    let pos = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      const m = line.match(/^(\*+)\s*(.*)$/);
      if (!m) continue;
      const level = m[1].length;
      const content = m[2].trim();
      // Extract link target if [[Target|Label]] or [[Target]]; else treat as heading.
      const linkMatch = content.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
      if (level === 1) {
        // Top-level: usually a heading label; not a link.
        currentSection = content.replace(/[*\[\]|]/g, "").trim();
      } else if (linkMatch) {
        const target = linkMatch[1].trim().replace(/_/g, " ");
        if (target) {
          out.push({
            hub_source: "MediaWiki:Wiki-navigation",
            section: currentSection,
            link_title: target,
            position: pos++,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Parse Main Page HTML: for every heading inside #mw-content-text, collect the
// outgoing article links until the next heading. Those form that hub's section.
async function parseMainPageHubs(
  origin: string,
  mainpage: string
): Promise<HubLink[]> {
  const parsed = await parsePage(origin, mainpage, ["text"]);
  const html: string = parsed?.text || "";
  if (!html) return [];
  const $ = cheerio.load(html);
  const out: HubLink[] = [];
  let section = "";
  let pos = 0;
  // Walk body in document order.
  $("h1, h2, h3, h4, a").each((_i, el) => {
    const tag = (el as any).tagName?.toLowerCase?.();
    if (!tag) return;
    if (/^h[1-4]$/.test(tag)) {
      section = $(el).text().replace(/\[edit\]/gi, "").trim();
      return;
    }
    if (tag === "a") {
      const href = $(el).attr("href") || "";
      const m = href.match(/^\/wiki\/([^?#]+)/);
      if (!m) return;
      const target = decodeURIComponent(m[1]).replace(/_/g, " ");
      // Skip categories, files, special, and policy namespaces.
      if (/^(Category|File|Special|Help|Template|User|Portal|MediaWiki):/.test(target))
        return;
      out.push({
        hub_source: mainpage,
        section,
        link_title: target,
        position: pos++,
      });
    }
  });
  // De-duplicate (main pages repeat links).
  const seen = new Set<string>();
  return out.filter((h) => {
    const k = `${h.section}::${h.link_title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function collectHubs(origin: string): Promise<HubLink[]> {
  const { mainpage } = await siteInfo(origin).catch(() => ({
    mainpage: "Main Page",
  }));
  const [nav, main] = await Promise.all([
    parseWikiNavigation(origin),
    parseMainPageHubs(origin, mainpage),
  ]);
  return [...nav, ...main];
}
