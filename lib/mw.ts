// lib/mw.ts
// Minimal typed MediaWiki API client for Fandom wikis.
// - Batches where possible (up to 500 titles / categorymembers).
// - Follows `continue` tokens.
// - Applies a soft token-bucket rate limiter to stay polite.
// - Never touches the LLM.

const UA =
  "FandomExplorer/1.0 (+https://github.com/Otherly-RV/FANDOM_EXPLORER)";

// ---------- rate limiter (token bucket, per-process) ----------
// Fandom tolerates moderate concurrency; we target ~15 req/s sustained.
const RATE_PER_SEC = 15;
const BURST = 30;
const buckets = new Map<string, { tokens: number; last: number }>();

async function takeToken(origin: string): Promise<void> {
  let b = buckets.get(origin);
  const now = Date.now();
  if (!b) {
    b = { tokens: BURST, last: now };
    buckets.set(origin, b);
  }
  // Refill.
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(BURST, b.tokens + elapsed * RATE_PER_SEC);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return;
  }
  const waitMs = Math.ceil(((1 - b.tokens) / RATE_PER_SEC) * 1000);
  await new Promise((r) => setTimeout(r, waitMs));
  return takeToken(origin);
}

// ---------- low-level fetch with retry ----------
export async function mwGet<T = any>(
  origin: string,
  params: Record<string, string | number | boolean>
): Promise<T> {
  const u = new URL(`${origin}/api.php`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set("format", "json");
  u.searchParams.set("formatversion", "2");

  let attempt = 0;
  // 3 retries with exponential backoff on 429/5xx.
  while (true) {
    await takeToken(origin);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    let r: Response;
    try {
      r = await fetch(u.toString(), {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctl.signal,
        next: { revalidate: 3600 },
      });
    } catch (e: any) {
      clearTimeout(t);
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      throw new Error(`MW fetch failed: ${e?.message || e}`);
    }
    clearTimeout(t);
    if (r.ok) {
      const j = (await r.json()) as any;
      if (j.error) throw new Error(`MW error: ${j.error.info || j.error.code}`);
      return j as T;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise((res) => setTimeout(res, backoff));
      attempt++;
      continue;
    }
    throw new Error(`MW HTTP ${r.status} for ${u.pathname}${u.search}`);
  }
}

// ---------- helpers: continue loop ----------
export async function mwQueryAll<T = any>(
  origin: string,
  base: Record<string, string | number | boolean>,
  pick: (j: any) => T[],
  opts: { max?: number; onBatch?: (items: T[]) => void | Promise<void> } = {}
): Promise<T[]> {
  const out: T[] = [];
  const max = opts.max ?? Infinity;
  let cont: Record<string, string> = {};
  while (true) {
    const j = await mwGet<any>(origin, { ...base, ...cont });
    const items = pick(j) || [];
    if (items.length) {
      out.push(...items);
      if (opts.onBatch) await opts.onBatch(items);
    }
    if (out.length >= max) return out.slice(0, max);
    if (!j.continue) return out;
    cont = j.continue;
  }
}

// ---------- category members ----------
export type CmPage = { pageid: number; ns: number; title: string };
export async function categoryMembers(
  origin: string,
  category: string, // "Category:Foo" or "Foo" — we normalize
  cmtype: "page" | "subcat" | "page|subcat" = "page|subcat",
  max = Infinity,
  onBatch?: (items: CmPage[]) => void | Promise<void>
): Promise<CmPage[]> {
  const cmtitle = category.startsWith("Category:")
    ? category
    : `Category:${category}`;
  return mwQueryAll<CmPage>(
    origin,
    {
      action: "query",
      list: "categorymembers",
      cmtitle,
      cmtype,
      cmlimit: 500,
    },
    (j) => j.query?.categorymembers ?? [],
    { max, onBatch }
  );
}

// ---------- page categories (batched) ----------
export type PageCats = { title: string; categories: string[] };
export async function pageCategoriesBatch(
  origin: string,
  titles: string[]
): Promise<PageCats[]> {
  // MediaWiki accepts up to 50 titles in most queries for props; categorymembers allows 500 but prop=categories is per-title.
  const CHUNK = 50;
  const result: PageCats[] = [];
  for (let i = 0; i < titles.length; i += CHUNK) {
    const slice = titles.slice(i, i + CHUNK);
    const all = await mwQueryAll<any>(
      origin,
      {
        action: "query",
        prop: "categories",
        cllimit: "max",
        clshow: "!hidden",
        titles: slice.join("|"),
      },
      (j) => j.query?.pages ?? []
    );
    // Merge pages across continue batches by title (same page can appear multiple times).
    const merged = new Map<string, Set<string>>();
    for (const p of all) {
      const t: string = p.title;
      if (!merged.has(t)) merged.set(t, new Set());
      const set = merged.get(t)!;
      for (const c of p.categories || []) {
        const name: string = c.title || "";
        if (name) set.add(name.replace(/^Category:/, "").replace(/_/g, " "));
      }
    }
    for (const [title, cats] of merged)
      result.push({ title, categories: [...cats] });
  }
  return result;
}

// ---------- single-page parse (used for policy + hubs) ----------
export async function parsePage(
  origin: string,
  page: string,
  extraProps: string[] = ["text", "sections", "links", "categories"]
): Promise<any | null> {
  try {
    const j = await mwGet<any>(origin, {
      action: "parse",
      page,
      prop: extraProps.join("|"),
      redirects: 1,
    });
    return j.parse || null;
  } catch {
    return null;
  }
}

// ---------- site info (optional, for main page title) ----------
export async function siteInfo(origin: string): Promise<{
  mainpage: string;
  sitename: string;
  lang: string;
}> {
  const j = await mwGet<any>(origin, {
    action: "query",
    meta: "siteinfo",
    siprop: "general",
  });
  const g = j.query?.general || {};
  return {
    mainpage: g.mainpage || "Main Page",
    sitename: g.sitename || "",
    lang: g.lang || "en",
  };
}

// ---------- url helpers ----------
export function parseFandomOrigin(input: string): string {
  const u = new URL(input);
  if (!u.hostname.endsWith("fandom.com"))
    throw new Error("Not a fandom.com URL");
  return u.origin;
}

export function titleToUrl(origin: string, title: string): string {
  return `${origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}
