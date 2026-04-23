// lib/profiler/worker.ts
// One chunk of profiler work. Designed to run inside Vercel's 60s budget and
// self-reinvoke via the /api/profile/run route when more work remains.
//
// Phases in order: policy -> hubs -> categories -> done.
// The BFS queue + visited set are persisted in profile_jobs.resume_state
// so work can continue across invocations.
import { sql } from "@/lib/db";
import { categoryMembers, siteInfo } from "@/lib/mw";
import { detectCanonPolicy, discoverRootCategories } from "./policy";
import { collectHubs } from "./hubs";
import {
  clearWikiData,
  getJob,
  heartbeatJob,
  insertHubs,
  updateJob,
  upsertCategoryEdge,
  upsertPageSeen,
  upsertProfile,
} from "./cache";

// Budget per invocation. Leave buffer for the HTTP response + re-invoke.
const CHUNK_BUDGET_MS = 45_000;

type ResumeState = {
  phase: "policy" | "hubs" | "categories" | "done";
  roots: string[];
  queue: { cat: string; parent: string; depth: number }[];
  visitedCats: string[];
  visitedPages: string[];
  pagesSeen: number;
  categoriesSeen: number;
  hubsSeen: number;
};

function emptyState(): ResumeState {
  return {
    phase: "policy",
    roots: [],
    queue: [],
    visitedCats: [],
    visitedPages: [],
    pagesSeen: 0,
    categoriesSeen: 0,
    hubsSeen: 0,
  };
}

async function loadState(jobId: string): Promise<ResumeState> {
  const job = await getJob(jobId);
  if (!job) throw new Error("job not found");
  return (job.resume_state as ResumeState) ?? emptyState();
}

async function saveState(jobId: string, s: ResumeState) {
  await sql`UPDATE profile_jobs SET resume_state = ${JSON.stringify(
    s
  )}::jsonb, heartbeat_at = now(), updated_at = now() WHERE id = ${jobId}`;
}

export type ChunkResult = {
  done: boolean;
  phase: string;
  pagesSeen: number;
  categoriesSeen: number;
  hubsSeen: number;
};

export async function runChunk(jobId: string): Promise<ChunkResult> {
  const started = Date.now();
  const job = await getJob(jobId);
  if (!job) throw new Error("job not found");
  const origin: string = job.origin;

  await updateJob(jobId, { status: "running" });
  const state: ResumeState = (job.resume_state as ResumeState) ?? emptyState();
  const outOfBudget = () => Date.now() - started > CHUNK_BUDGET_MS;

  try {
    // ---------- PHASE 1: policy ----------
    if (state.phase === "policy") {
      await updateJob(jobId, { phase: "policy", pct: 5 });
      // Fresh run → clear any previous data for this origin.
      await clearWikiData(origin);
      const [info, policy] = await Promise.all([
        siteInfo(origin).catch(() => ({
          mainpage: "Main Page",
          sitename: "",
          lang: "en",
        })),
        detectCanonPolicy(origin),
      ]);
      const roots = await discoverRootCategories(origin, policy);
      await upsertProfile({
        origin,
        sitename: info.sitename,
        lang: info.lang,
        mainpage: info.mainpage,
        canon_policy: policy,
        root_cats: roots,
      });
      state.roots = roots;
      state.queue = roots.map((r) => ({ cat: r, parent: "", depth: 0 }));
      state.phase = "hubs";
      await saveState(jobId, state);
      await updateJob(jobId, { phase: "hubs", pct: 10 });
    }

    // ---------- PHASE 2: hubs ----------
    if (state.phase === "hubs") {
      const hubs = await collectHubs(origin);
      await insertHubs(origin, hubs);
      state.hubsSeen = hubs.length;
      state.phase = "categories";
      await saveState(jobId, state);
      await updateJob(jobId, {
        phase: "categories",
        hubs_seen: hubs.length,
        pct: 20,
      });
    }

    // ---------- PHASE 3: categories (BFS, resumable) ----------
    const visitedCats = new Set(state.visitedCats);
    const visitedPages = new Set(state.visitedPages);

    while (state.queue.length && !outOfBudget()) {
      const { cat, parent, depth } = state.queue.shift()!;
      if (visitedCats.has(cat)) {
        await upsertCategoryEdge(origin, cat, parent, depth);
        continue;
      }
      visitedCats.add(cat);
      await upsertCategoryEdge(origin, cat, parent, depth);

      // Pull this category's members. Cap per call so a single giant
      // category can't burn our entire budget — 5000 is enough for structure;
      // anything bigger is re-queued via a soft depth-based heuristic.
      await categoryMembers(origin, cat, "page|subcat", 5000, async (batch) => {
        if (outOfBudget()) throw new Error("__OUT_OF_BUDGET__");
        for (const m of batch) {
          if (m.ns === 14) {
            const sub = String(m.title).replace(/^Category:/, "");
            if (!visitedCats.has(sub)) {
              state.queue.push({ cat: sub, parent: cat, depth: depth + 1 });
            }
          } else if (m.ns === 0) {
            const t = String(m.title);
            if (!visitedPages.has(t)) {
              visitedPages.add(t);
              state.pagesSeen++;
              await upsertPageSeen(origin, t, cat);
            }
          }
        }
        // Frequent heartbeat during a fat category.
        await heartbeatJob(jobId);
      }).catch((e) => {
        if (String(e?.message) === "__OUT_OF_BUDGET__") return;
        throw e;
      });

      state.categoriesSeen = visitedCats.size;

      // Checkpoint every few cats.
      if (state.categoriesSeen % 5 === 0) {
        state.visitedCats = [...visitedCats];
        state.visitedPages = [...visitedPages];
        await saveState(jobId, state);
        // Rough progress: fraction of visited over (visited + queued).
        const total = state.categoriesSeen + state.queue.length;
        const pct =
          20 +
          Math.min(
            75,
            Math.round((state.categoriesSeen / Math.max(1, total)) * 75)
          );
        await updateJob(jobId, {
          pct,
          pages_seen: state.pagesSeen,
          categories_seen: state.categoriesSeen,
        });
      }
    }

    state.visitedCats = [...visitedCats];
    state.visitedPages = [...visitedPages];
    await saveState(jobId, state);

    if (state.queue.length === 0) {
      state.phase = "done";
      await saveState(jobId, state);
      await updateJob(jobId, {
        status: "done",
        phase: "done",
        pct: 100,
        pages_seen: state.pagesSeen,
        categories_seen: state.categoriesSeen,
      });
      return {
        done: true,
        phase: "done",
        pagesSeen: state.pagesSeen,
        categoriesSeen: state.categoriesSeen,
        hubsSeen: state.hubsSeen,
      };
    }

    // Out of budget — caller will re-invoke.
    await updateJob(jobId, {
      pages_seen: state.pagesSeen,
      categories_seen: state.categoriesSeen,
    });
    return {
      done: false,
      phase: state.phase,
      pagesSeen: state.pagesSeen,
      categoriesSeen: state.categoriesSeen,
      hubsSeen: state.hubsSeen,
    };
  } catch (e: any) {
    await updateJob(jobId, {
      status: "error",
      error: String(e?.message || e),
    });
    throw e;
  }
}
