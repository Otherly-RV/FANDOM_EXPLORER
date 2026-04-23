// lib/profiler/categories.ts
// Layer 2: BFS-walk the category DAG starting from seed roots.
// Depth is unbounded (only stopped by cycles + visited set).
// Persists edges + members incrementally and reports progress via a callback.
import { categoryMembers } from "@/lib/mw";

export type WalkProgress = {
  depth: number;
  categoriesSeen: number;
  pagesSeen: number;
  currentCategory: string;
};

export type CategoryEdge = { category: string; parent: string; depth: number };
export type PageSeen = { title: string; viaCategory: string };

export type WalkOptions = {
  maxPages?: number; // safety net: huge IPs can have >200k pages
  onEdge?: (e: CategoryEdge) => void | Promise<void>;
  onPage?: (p: PageSeen) => void | Promise<void>;
  onProgress?: (p: WalkProgress) => void | Promise<void>;
  // How often to report progress (every N pages).
  progressEvery?: number;
  // Abort signal (stop between batches).
  signal?: { aborted: boolean };
};

export async function walkCategoryTree(
  origin: string,
  roots: string[],
  opts: WalkOptions = {}
): Promise<{ categoriesSeen: number; pagesSeen: number }> {
  const visitedCats = new Set<string>();
  const visitedPages = new Set<string>();
  const progressEvery = opts.progressEvery ?? 250;
  const maxPages = opts.maxPages ?? Infinity;

  type QItem = { cat: string; parent: string; depth: number };
  const queue: QItem[] = roots.map((r) => ({ cat: r, parent: "", depth: 0 }));

  let pagesSeen = 0;
  let lastReport = 0;

  while (queue.length) {
    if (opts.signal?.aborted) break;
    if (pagesSeen >= maxPages) break;

    const { cat, parent, depth } = queue.shift()!;
    const key = cat;
    if (visitedCats.has(key)) {
      // Still record the edge so the DAG is faithful.
      if (opts.onEdge) await opts.onEdge({ category: cat, parent, depth });
      continue;
    }
    visitedCats.add(key);
    if (opts.onEdge) await opts.onEdge({ category: cat, parent, depth });

    // Pull all members (pages + subcats). Paginated internally via continue.
    await categoryMembers(
      origin,
      cat,
      "page|subcat",
      Infinity,
      async (batch) => {
        if (opts.signal?.aborted) return;
        for (const m of batch) {
          if (m.ns === 14) {
            // Subcategory — enqueue.
            const sub = String(m.title).replace(/^Category:/, "");
            if (!visitedCats.has(sub)) {
              queue.push({ cat: sub, parent: cat, depth: depth + 1 });
            }
          } else if (m.ns === 0) {
            const t = String(m.title);
            if (!visitedPages.has(t)) {
              visitedPages.add(t);
              pagesSeen++;
              if (opts.onPage)
                await opts.onPage({ title: t, viaCategory: cat });
              if (pagesSeen - lastReport >= progressEvery) {
                lastReport = pagesSeen;
                if (opts.onProgress)
                  await opts.onProgress({
                    depth,
                    categoriesSeen: visitedCats.size,
                    pagesSeen,
                    currentCategory: cat,
                  });
              }
              if (pagesSeen >= maxPages) return;
            }
          }
        }
      }
    );
  }

  if (opts.onProgress)
    await opts.onProgress({
      depth: -1,
      categoriesSeen: visitedCats.size,
      pagesSeen,
      currentCategory: "",
    });

  return { categoriesSeen: visitedCats.size, pagesSeen };
}
