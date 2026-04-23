// app/api/profile/overview/route.ts
// GET ?origin=...
//   -> A *semantic* overview of how a wiki is organized.
//      We don't just dump the raw category DAG — we bucketize the top
//      categories into thematic groups (Characters, Locations, Story/Events,
//      Media/Works, Factions, Species, Objects, Canon split, Meta) based on
//      their names, and rank them by page count so the user can actually see
//      "what this wiki is about".
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Bucket = {
  id: string;
  label: string;
  pageCount: number;
  categoryCount: number;
  topCategories: { name: string; pageCount: number; samplePages: string[] }[];
};

// Categories that are wiki housekeeping, not subject-matter structure.
// Skipped entirely from the overview (still visible in the raw DAG below).
const MAINTENANCE_RE =
  /\b(stubs?|articles?\s+(?:needing|requiring|in\s+need\s+of|with|missing|containing|to\s+be)|incomplete|cleanup|disambiguations?|redirects?|templates?|blog\s*posts?|galleries|gallery(?:\s+subpages)?|subpages?|candidates?\s+for\s+deletion|speedy\s+deletion|pages\s+with|hidden(?:\s+categories)?|tracking\s+categories?|broken\s+links?|missing\s+images?|administration|administrators?|moderators?|bots?|user(?:names?|boxes?|pages?)?|sandboxes?|unused|orphaned|protected\s+pages?|watercooler|file\s+redirects?|expanded\s+cargo|validation|maintenance)\b/i;

// Order matters: first matching rule wins, so more-specific patterns must
// come before broad ones (e.g. "Characters by species" should match
// characters, not species).
const RULES: { id: string; label: string; re: RegExp }[] = [
  // Canon / continuity split — surface this first since it's what the
  // profiler is named after.
  {
    id: "canon",
    label: "Canon & continuity",
    re: /\b(canon(?:ical|icity)?|legends|non[-\s]?canon|apocrypha|continuity|expanded universe|alternate\s+continuity|retcon)\b/i,
  },
  {
    id: "characters",
    label: "Characters & people",
    re: /\b(character|people|persons?|individuals?|protagonist|antagonist|heroes?|villains?|cast|crew|members?|residents?|citizens?|inhabitants?|npcs?|bosses?|fighters?|combatants?|real[-\s]?life\s+people)\b/i,
  },
  {
    id: "species",
    label: "Species & races",
    re: /\b(species|races?|creatures?|beasts?|animals?|aliens?|monsters?|mobs?|fauna|flora|sentients?|beings?)\b/i,
  },
  {
    id: "factions",
    label: "Factions & organizations",
    re: /\b(organi[sz]ations?|factions?|groups?|gangs?|guilds?|orders?|armies|militar(?:y|ies)|teams?|clans?|houses?|families|dynasties|governments?|empires?|republics?|companies|corporations?|councils?|alliances?)\b/i,
  },
  {
    id: "locations",
    label: "Locations & worlds",
    re: /\b(locations?|places?|planets?|worlds?|regions?|countries|cities|towns?|villages?|realms?|galax(?:y|ies)|systems?|continents?|kingdoms?|territor(?:y|ies)|zones?|areas?|maps?|settings?|environments?|dungeons?|biomes?|geograph(?:y|ies)|stars?|stages?|arenas?|levels?)\b/i,
  },
  {
    id: "events",
    label: "Story, events & timeline",
    re: /\b(events?|battles?|wars?|conflicts?|timelines?|eras?|periods?|histor(?:y|ies)|dates?|years?|centuries|decades|episodes?|seasons?|arcs?|chapters?|quests?|missions?|storylines?|plots?|campaigns?|crusades?|tournaments?)\b/i,
  },
  {
    id: "media",
    label: "Media & works",
    re: /\b(films?|movies?|books?|novels?|novellas?|comics?|manga|games?|video ?games?|series|franchises?|media|works?|publications?|issues?|volumes?|magazines?|soundtracks?|albums?|songs?|music|shows?|anime|audios?|podcasts?|merchandise|animations?|toys?|crossovers?)\b/i,
  },
  {
    id: "gameplay",
    label: "Gameplay & mechanics",
    re: /\b(attacks?|moves?|movements?|techniques?|combos?|super\s+(?:combos?|arts?)|super\s+arts?|special\s+moves?|ex[-\s]?able|overdrive|overheads?|anti[-\s]?air|projectiles?|grabs?|throws?|kicks?|punches?|punching|kicking|taunts?|game\s+modes?|mechanics?|gameplay|cosmetics?|costumes?|skins?|outfits?|move\s+lists?|abilities|skills?|powers?|spells?|status\s+effects?|buffs?|debuffs?|armou?r\s+break|unblockable|charge\s+attacks?|command\s+grabs?|stances?|counters?)\b/i,
  },
  {
    id: "objects",
    label: "Objects & technology",
    re: /\b(weapons?|items?|objects?|artifacts?|vehicles?|ships?|starships?|spacecraft|mecha|technolog(?:y|ies)|equipments?|gear|tools?|devices?|machines?|buildings?|structures?|architectures?|relics?|treasures?)\b/i,
  },
  {
    id: "concepts",
    label: "Concepts & lore",
    re: /\b(concepts?|lore|religions?|mytholog(?:y|ies)|magic|terms?|terminolog(?:y|ies)|philosoph(?:y|ies)|languages?|cultures?|traditions?|customs?|laws?|rituals?|theor(?:y|ies))\b/i,
  },
];

function classify(name: string): { id: string; label: string } | null {
  if (MAINTENANCE_RE.test(name)) return null;
  for (const r of RULES) if (r.re.test(name)) return { id: r.id, label: r.label };
  return { id: "other", label: "Other" };
}

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

  const topN = Math.max(
    50,
    Math.min(1000, Number(req.nextUrl.searchParams.get("top") || 400))
  );
  const perBucket = Math.max(
    3,
    Math.min(30, Number(req.nextUrl.searchParams.get("perBucket") || 10))
  );

  // Grand totals.
  const [totals] = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM wiki_pages      WHERE origin = ${origin}) AS pages,
      (SELECT COUNT(DISTINCT category)::int FROM wiki_categories WHERE origin = ${origin}) AS categories,
      (SELECT COUNT(*)::int FROM wiki_hubs       WHERE origin = ${origin}) AS hub_links
  `) as any[];

  // Top categories by direct page membership.
  const catRows = (await sql`
    SELECT cat AS name, COUNT(*)::int AS page_count
    FROM wiki_pages,
         LATERAL jsonb_array_elements_text(categories) AS cat
    WHERE origin = ${origin}
    GROUP BY cat
    ORDER BY page_count DESC
    LIMIT ${topN}
  `) as any[];

  if (catRows.length === 0) {
    return NextResponse.json({
      origin,
      totals,
      buckets: [],
      unclassified: [],
      note: "No category/page data yet. Re-profile the wiki.",
    });
  }

  // Bucketize.
  type CatAgg = { name: string; pageCount: number; bucket: string; label: string };
  const cats: CatAgg[] = [];
  let skippedMaintenance = 0;
  for (const r of catRows) {
    const c = classify(String(r.name));
    if (!c) {
      skippedMaintenance++;
      continue;
    }
    cats.push({
      name: String(r.name),
      pageCount: Number(r.page_count) || 0,
      bucket: c.id,
      label: c.label,
    });
  }

  // For the top categories per bucket, pull a few sample page titles. We do
  // one query per bucket's top categories batched together.
  const buckets = new Map<string, Bucket>();
  for (const c of cats) {
    let b = buckets.get(c.bucket);
    if (!b) {
      b = {
        id: c.bucket,
        label: c.label,
        pageCount: 0,
        categoryCount: 0,
        topCategories: [],
      };
      buckets.set(c.bucket, b);
    }
    b.pageCount += c.pageCount;
    b.categoryCount += 1;
    if (b.topCategories.length < perBucket) {
      b.topCategories.push({
        name: c.name,
        pageCount: c.pageCount,
        samplePages: [],
      });
    }
  }

  // Gather sample pages for every category we decided to surface.
  const surfaced = Array.from(buckets.values())
    .flatMap((b) => b.topCategories.map((t) => t.name));
  if (surfaced.length) {
    const sampleRows = (await sql`
      SELECT cat AS category, title
      FROM (
        SELECT
          cat,
          title,
          ROW_NUMBER() OVER (PARTITION BY cat ORDER BY title) AS rn
        FROM wiki_pages,
             LATERAL jsonb_array_elements_text(categories) AS cat
        WHERE origin = ${origin} AND cat = ANY(${surfaced}::text[])
      ) s
      WHERE rn <= 5
    `) as any[];
    const byCat = new Map<string, string[]>();
    for (const r of sampleRows) {
      const arr = byCat.get(r.category) ?? [];
      arr.push(r.title);
      byCat.set(r.category, arr);
    }
    for (const b of buckets.values()) {
      for (const t of b.topCategories) {
        t.samplePages = byCat.get(t.name) ?? [];
      }
    }
  }

  // Sort buckets by total pages (desc), topCategories within each (desc).
  const bucketOrder = [
    "canon",
    "characters",
    "factions",
    "species",
    "locations",
    "events",
    "media",
    "gameplay",
    "objects",
    "concepts",
    "other",
  ];
  const bucketList = Array.from(buckets.values()).sort((a, b) => {
    // Primary: predefined order.
    const ai = bucketOrder.indexOf(a.id);
    const bi = bucketOrder.indexOf(b.id);
    if (ai !== bi) return ai - bi;
    // Secondary: page count desc.
    return b.pageCount - a.pageCount;
  });
  for (const b of bucketList) {
    b.topCategories.sort((x, y) => y.pageCount - x.pageCount);
  }

  return NextResponse.json({
    origin,
    totals,
    buckets: bucketList,
    scannedCategories: cats.length,
    skippedMaintenance,
  });
}
