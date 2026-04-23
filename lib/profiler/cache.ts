// lib/profiler/cache.ts
// Persistence helpers for the canon profiler.
// - Profiles are permanent once written; `stale_after` is an informational hint.
// - `?refresh=1` forces a new run which overwrites the cached rows atomically.
import { sql } from "@/lib/db";
import type { CanonPolicy } from "./policy";
import type { HubLink } from "./hubs";

export type WikiProfileRow = {
  origin: string;
  sitename: string | null;
  lang: string | null;
  mainpage: string | null;
  canon_policy: CanonPolicy;
  root_cats: string[];
  profiled_at: string;
  stale_after: string;
};

export async function getProfile(origin: string): Promise<WikiProfileRow | null> {
  const rows = (await sql`
    SELECT origin, sitename, lang, mainpage, canon_policy, root_cats, profiled_at, stale_after
    FROM wiki_profiles WHERE origin = ${origin}
  `) as any[];
  return rows[0] ?? null;
}

export async function upsertProfile(p: {
  origin: string;
  sitename?: string;
  lang?: string;
  mainpage?: string;
  canon_policy: CanonPolicy;
  root_cats: string[];
}) {
  await sql`
    INSERT INTO wiki_profiles (origin, sitename, lang, mainpage, canon_policy, root_cats, profiled_at, stale_after)
    VALUES (${p.origin}, ${p.sitename ?? null}, ${p.lang ?? null}, ${p.mainpage ?? null},
            ${JSON.stringify(p.canon_policy)}::jsonb,
            ${JSON.stringify(p.root_cats)}::jsonb,
            now(), now() + interval '8 hours')
    ON CONFLICT (origin) DO UPDATE SET
      sitename = EXCLUDED.sitename,
      lang = EXCLUDED.lang,
      mainpage = EXCLUDED.mainpage,
      canon_policy = EXCLUDED.canon_policy,
      root_cats = EXCLUDED.root_cats,
      profiled_at = now(),
      stale_after = now() + interval '8 hours'
  `;
}

export async function clearWikiData(origin: string) {
  await sql`DELETE FROM wiki_categories WHERE origin = ${origin}`;
  await sql`DELETE FROM wiki_hubs WHERE origin = ${origin}`;
  await sql`DELETE FROM wiki_pages WHERE origin = ${origin}`;
}

export async function upsertCategoryEdge(
  origin: string,
  category: string,
  parent: string,
  depth: number
) {
  await sql`
    INSERT INTO wiki_categories (origin, category, parent, depth)
    VALUES (${origin}, ${category}, ${parent}, ${depth})
    ON CONFLICT (origin, category, parent) DO UPDATE SET depth = LEAST(wiki_categories.depth, EXCLUDED.depth)
  `;
}

// Bulk insert pages seen during BFS (just title + categories we encountered via).
// Classifier (Layer 4) fills in type / canon_status / era later.
export async function upsertPageSeen(
  origin: string,
  title: string,
  viaCategory: string
) {
  await sql`
    INSERT INTO wiki_pages (origin, title, categories, updated_at)
    VALUES (${origin}, ${title}, ${JSON.stringify([viaCategory])}::jsonb, now())
    ON CONFLICT (origin, title) DO UPDATE SET
      categories = (
        SELECT to_jsonb(ARRAY(SELECT DISTINCT jsonb_array_elements_text(
          wiki_pages.categories || EXCLUDED.categories
        ))))
      , updated_at = now()
  `;
}

export async function insertHubs(origin: string, hubs: HubLink[]) {
  if (!hubs.length) return;
  // Clear old then batch insert — simpler than upsert-per-row for a small set.
  await sql`DELETE FROM wiki_hubs WHERE origin = ${origin}`;
  // Insert one-by-one; hub lists are small (< a few thousand).
  for (const h of hubs) {
    await sql`
      INSERT INTO wiki_hubs (origin, hub_source, section, link_title, position)
      VALUES (${origin}, ${h.hub_source}, ${h.section}, ${h.link_title}, ${h.position})
      ON CONFLICT DO NOTHING
    `;
  }
}

// ---------- jobs ----------
export type JobStatus = "queued" | "running" | "done" | "error";

export async function createJob(id: string, origin: string) {
  await sql`
    INSERT INTO profile_jobs (id, origin, status, phase)
    VALUES (${id}, ${origin}, 'queued', 'queued')
  `;
}

export async function getJob(id: string): Promise<any | null> {
  const rows = (await sql`SELECT * FROM profile_jobs WHERE id = ${id}`) as any[];
  return rows[0] ?? null;
}

export async function findActiveJob(origin: string): Promise<any | null> {
  const rows = (await sql`
    SELECT * FROM profile_jobs
    WHERE origin = ${origin} AND status IN ('queued','running')
      AND heartbeat_at > now() - interval '2 minutes'
    ORDER BY created_at DESC LIMIT 1
  `) as any[];
  return rows[0] ?? null;
}

export async function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus;
    phase: string;
    pages_seen: number;
    categories_seen: number;
    hubs_seen: number;
    pct: number;
    error: string | null;
  }>
) {
  const p = patch;
  await sql`
    UPDATE profile_jobs SET
      status          = COALESCE(${p.status ?? null}, status),
      phase           = COALESCE(${p.phase ?? null}, phase),
      pages_seen      = COALESCE(${p.pages_seen ?? null}, pages_seen),
      categories_seen = COALESCE(${p.categories_seen ?? null}, categories_seen),
      hubs_seen       = COALESCE(${p.hubs_seen ?? null}, hubs_seen),
      pct             = COALESCE(${p.pct ?? null}, pct),
      error           = COALESCE(${p.error ?? null}, error),
      heartbeat_at    = now(),
      updated_at      = now()
    WHERE id = ${id}
  `;
}

export async function heartbeatJob(id: string) {
  await sql`UPDATE profile_jobs SET heartbeat_at = now() WHERE id = ${id}`;
}
