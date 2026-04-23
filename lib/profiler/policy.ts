// lib/profiler/policy.ts
// Layer 1: detect how this wiki encodes canon vs non-canon.
// We look at three sources:
//   1. Categories that look like canon/legends/continuity buckets.
//   2. Dedicated policy pages (Help:Canon, Canon, Canonicity).
//   3. Main Page / site nav hints (separate-wiki mentions).
import { allCategoriesBySize, categoryMembers, mwGet, parsePage, siteInfo } from "@/lib/mw";

export type CanonPolicy = {
  mode: "category-split" | "separate-wiki" | "infobox-field" | "none";
  canonCategory?: string;
  nonCanonCategory?: string;
  infoboxField?: string;
  notes?: string[];
  // Hints we found (for debugging / UI).
  candidateCategories?: string[];
  policyPages?: string[];
};

const CANON_RE = /^(Canon(?:ical)?|Canonicity)$/i;
const NONCANON_RE =
  /^(Legends|Non[-\s]?canon|Apocrypha|Alternate[-\s]?continuity|Legacy continuity|Expanded Universe)$/i;
const CONTINUITY_SUFFIX_RE = /\s+continuity$/i;

export async function detectCanonPolicy(origin: string): Promise<CanonPolicy> {
  const notes: string[] = [];
  const candidateCategories: string[] = [];
  const policyPages: string[] = [];

  // 1. Look for top-level canon-ish categories by asking for their members
  //    (fast existence check + tells us which side has content).
  const probeCats = [
    "Canon",
    "Canonical",
    "Legends",
    "Non-canon",
    "Noncanon",
    "Apocrypha",
  ];
  const found: Record<string, number> = {};
  await Promise.all(
    probeCats.map(async (c) => {
      try {
        const j = await mwGet<any>(origin, {
          action: "query",
          list: "categorymembers",
          cmtitle: `Category:${c}`,
          cmlimit: 1,
        });
        const items = j.query?.categorymembers ?? [];
        if (items.length > 0) {
          found[c] = items.length;
          candidateCategories.push(c);
        }
      } catch {
        /* ignore */
      }
    })
  );

  // 2. Probe policy pages.
  for (const p of ["Help:Canon", "Canon", "Canonicity", "Canon policy"]) {
    const parsed = await parsePage(origin, p, ["text"]);
    if (parsed && parsed.title) policyPages.push(parsed.title);
  }

  // 3. Decide.
  let mode: CanonPolicy["mode"] = "none";
  let canonCategory: string | undefined;
  let nonCanonCategory: string | undefined;

  const canonSide = Object.keys(found).find((c) => CANON_RE.test(c));
  const legendsSide = Object.keys(found).find((c) => NONCANON_RE.test(c));
  if (canonSide && legendsSide) {
    mode = "category-split";
    canonCategory = canonSide;
    nonCanonCategory = legendsSide;
    notes.push(
      `Found canon category "${canonSide}" and non-canon category "${legendsSide}".`
    );
  } else if (canonSide || legendsSide) {
    mode = "category-split";
    canonCategory = canonSide;
    nonCanonCategory = legendsSide;
    notes.push(
      "Partial canon split detected — only one side has a dedicated category."
    );
  } else if (policyPages.length > 0) {
    // Policy exists but no obvious category — likely handled per-article via infobox.
    mode = "infobox-field";
    notes.push(
      `Policy page present (${policyPages.join(
        ", "
      )}) but no canon/legends category found; assume infobox field encodes status.`
    );
  }

  // Separate-wiki hint: site name suggests "Legends" or "Canon" explicitly.
  try {
    const info = await siteInfo(origin);
    if (/legends/i.test(info.sitename) || /canon/i.test(info.sitename)) {
      notes.push(
        `Sitename "${info.sitename}" suggests this wiki is one side of a separate-wiki split.`
      );
      if (mode === "none") mode = "separate-wiki";
    }
  } catch {
    /* ignore */
  }

  return {
    mode,
    canonCategory,
    nonCanonCategory,
    notes,
    candidateCategories,
    policyPages,
  };
}

// Pick sensible root categories to seed BFS from.
// Strategy:
//   1. Probe the English-Wikipedia-convention meta categories (Browse, …)
//      which SOME Fandom wikis use.
//   2. Regardless, enumerate the wiki's largest real categories via
//      list=allcategories&acprop=size. These ARE the organizational
//      structure on wikis that don't bother with Browse/Contents.
//   3. Keep anything discovered by the canon-policy probe.
// De-duplicated, convention roots first, then by size desc.
export async function discoverRootCategories(
  origin: string,
  policy: CanonPolicy,
  opts: { topN?: number; minPages?: number } = {}
): Promise<string[]> {
  const topN = opts.topN ?? 40;
  const minPages = opts.minPages ?? 3;

  const conventionCandidates = [
    "Browse",
    "Contents",
    "Main topic classifications",
    "Articles",
  ];
  const conventionRoots: string[] = [];
  await Promise.all(
    conventionCandidates.map(async (c) => {
      try {
        const members = await categoryMembers(
          origin,
          c,
          "page|subcat",
          2 /* probe existence, require >1 to avoid empty stubs */
        );
        if (members.length > 1) conventionRoots.push(c);
      } catch {
        /* ignore */
      }
    })
  );

  // Enumerate real categories by size.
  let bySize: { name: string; pages: number }[] = [];
  try {
    const all = await allCategoriesBySize(origin, { minPages });
    bySize = all.slice(0, topN).map((c) => ({ name: c.name, pages: c.pages }));
  } catch {
    /* ignore — fall back to convention roots */
  }

  const roots: string[] = [];
  for (const r of conventionRoots) roots.push(r);
  for (const c of bySize) roots.push(c.name);
  if (policy.canonCategory) roots.push(policy.canonCategory);
  if (policy.nonCanonCategory) roots.push(policy.nonCanonCategory);

  // De-dupe, preserve order (convention → by-size → canon-policy).
  return [...new Set(roots)];
}
