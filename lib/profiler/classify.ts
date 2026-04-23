// lib/profiler/classify.ts
// Layer 4: given the structure collected in Layers 1–3, produce a canon record
// for a single page. This is intentionally heuristic + fast — no LLM.
//
// Output (per page):
//   { title, canonStatus, type, era[], media[], hubs[], categories[] }
import { sql } from "@/lib/db";
import { pageCategoriesBatch } from "@/lib/mw";
import type { CanonPolicy } from "./policy";

export type CanonRecord = {
  title: string;
  canonStatus: "canon" | "legends" | "ambiguous" | "unknown";
  type: string | null;
  era: string[];
  media: string[];
  hubs: string[];
  categories: string[];
};

// ---- heuristics ----
const TYPE_PATTERNS: [RegExp, string][] = [
  [/^Characters?$/i, "Character"],
  [/characters$/i, "Character"],
  [/^Species$/i, "Species"],
  [/species$/i, "Species"],
  [/^(Planets?|Locations?|Places?|Cities)$/i, "Location"],
  [/locations$/i, "Location"],
  [/planets$/i, "Location"],
  [/^(Events?|Battles?|Wars?)$/i, "Event"],
  [/battles$/i, "Event"],
  [/^(Factions?|Organizations?|Groups?)$/i, "Faction"],
  [/organizations$/i, "Faction"],
  [/^(Ships?|Vehicles?|Starships?)$/i, "Vehicle"],
  [/^(Weapons?|Items?|Artifacts?|Technology)$/i, "Item"],
  [/^(Films?|Movies?)$/i, "Film"],
  [/^(Novels?|Books?)$/i, "Novel"],
  [/^(Comics?|Issues?)$/i, "Comic"],
  [/^(Episodes?|Seasons?)$/i, "Episode"],
  [/^(Games?|Video\s*games?)$/i, "Game"],
];

const ERA_SUFFIX_RE =
  /\s+(era|age|period|saga|arc|epoch|chapter|timeline)$/i;
const MEDIA_HINTS: [RegExp, string][] = [
  [/^(Films?|Movies?)$/i, "Film"],
  [/^(Novels?|Books?)$/i, "Novel"],
  [/^(Comics?|Issues?)$/i, "Comic"],
  [/^(Episodes?)$/i, "Episode"],
  [/^(Games?|Video\s*games?)$/i, "Game"],
  [/Appearances$/i, "Appearances"],
];

function classifyFromCategories(
  cats: string[],
  policy: CanonPolicy
): Omit<CanonRecord, "title" | "hubs"> {
  let type: string | null = null;
  const era: string[] = [];
  const media: string[] = [];

  for (const c of cats) {
    if (!type) {
      for (const [re, t] of TYPE_PATTERNS) {
        if (re.test(c)) {
          type = t;
          break;
        }
      }
    }
    if (ERA_SUFFIX_RE.test(c)) era.push(c);
    for (const [re, m] of MEDIA_HINTS) {
      if (re.test(c)) {
        media.push(m);
        break;
      }
    }
  }

  // Canon status.
  let canonStatus: CanonRecord["canonStatus"] = "unknown";
  if (policy.mode === "category-split") {
    const isCanon = policy.canonCategory
      ? cats.some((c) => c === policy.canonCategory || c.startsWith(`${policy.canonCategory}/`))
      : false;
    const isLegends = policy.nonCanonCategory
      ? cats.some(
          (c) =>
            c === policy.nonCanonCategory ||
            c.startsWith(`${policy.nonCanonCategory}/`)
        )
      : false;
    if (isCanon && !isLegends) canonStatus = "canon";
    else if (isLegends && !isCanon) canonStatus = "legends";
    else if (isCanon && isLegends) canonStatus = "ambiguous";
  } else if (policy.mode === "separate-wiki") {
    // All pages on this wiki share the same side.
    canonStatus = /legend/i.test(policy.notes?.join(" ") || "")
      ? "legends"
      : "canon";
  }

  return {
    canonStatus,
    type,
    era: [...new Set(era)],
    media: [...new Set(media)],
    categories: cats,
  };
}

async function hubsForTitle(origin: string, title: string): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT hub_source || ' › ' || section AS label
    FROM wiki_hubs WHERE origin = ${origin} AND link_title = ${title}
  `) as any[];
  return rows.map((r) => r.label);
}

export async function classifyPages(
  origin: string,
  titles: string[],
  policy: CanonPolicy
): Promise<CanonRecord[]> {
  if (titles.length === 0) return [];
  const cats = await pageCategoriesBatch(origin, titles);
  const byTitle = new Map(cats.map((c) => [c.title, c.categories]));
  const out: CanonRecord[] = [];
  for (const t of titles) {
    const c = byTitle.get(t) ?? [];
    const partial = classifyFromCategories(c, policy);
    const hubs = await hubsForTitle(origin, t);
    out.push({ title: t, hubs, ...partial });
  }
  // Persist.
  for (const rec of out) {
    await sql`
      INSERT INTO wiki_pages (origin, title, type, canon_status, era, media, hubs, categories, updated_at)
      VALUES (${origin}, ${rec.title}, ${rec.type}, ${rec.canonStatus},
              ${JSON.stringify(rec.era)}::jsonb,
              ${JSON.stringify(rec.media)}::jsonb,
              ${JSON.stringify(rec.hubs)}::jsonb,
              ${JSON.stringify(rec.categories)}::jsonb,
              now())
      ON CONFLICT (origin, title) DO UPDATE SET
        type = EXCLUDED.type,
        canon_status = EXCLUDED.canon_status,
        era = EXCLUDED.era,
        media = EXCLUDED.media,
        hubs = EXCLUDED.hubs,
        categories = EXCLUDED.categories,
        updated_at = now()
    `;
  }
  return out;
}
