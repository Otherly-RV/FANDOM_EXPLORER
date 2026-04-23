// app/api/canon/inventory/route.ts
//
// STAGE 1 — fast inventory pass.
// Streams every category with a dominant infobox template and the titles
// of every member. NO page content is fetched here — that's stage 2
// (/api/canon/pages) which the client calls in chunks so no single request
// ever risks the Vercel timeout.
//
// SSE events:
//   progress     { step }
//   meta         { sitename, mainpage, articles, totalCategories }
//   group        { gid, category, totalMembers, titles: string[] }
//   error        { error }
//   done         {}

import { NextRequest } from "next/server";
import {
  allCategoriesBySize,
  categoryMembers,
  mwGet,
  parseFandomOrigin,
} from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_MEMBERS_FOR_GROUP = 4;

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const rawOrigin: string = body.origin || body.url || "";
  const perCategory = normalizeBudget(body.perCategory, 0);   // 0 => unlimited
  const topCategories = normalizeBudget(body.topCategories, 0);

  let origin = "";
  try {
    origin = rawOrigin.includes("/wiki/")
      ? parseFandomOrigin(rawOrigin)
      : new URL(rawOrigin).origin;
  } catch {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "bad origin" })}\n\n`,
      { headers: sseHeaders() }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event: string, data: any) => {
        if (closed) return;
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      try {
        send("progress", { step: "siteinfo + categories" });
        const [info, catsRaw] = await Promise.all([
          siteInfoPlus(origin),
          allCategoriesBySize(origin, { maxCategories: 3000, minPages: 3 }).catch(() => []),
        ]);
        send("meta", {
          sitename: info.sitename || new URL(origin).hostname,
          mainpage: info.mainpage,
          articles: info.articles,
          totalCategories: catsRaw.length,
        });

        const candidate = catsRaw
          .filter((c) => !isAdminCategory(c.name))
          .filter((c) => c.pages >= MIN_MEMBERS_FOR_GROUP)
          .slice(0, isFinite(topCategories) ? topCategories : catsRaw.length);

        send("progress", { step: `enumerating ${candidate.length} categories` });

        let gidCounter = 0;
        await runPool(candidate, 6, async (c) => {
          const gid = ++gidCounter;
          let titles: string[] = [];
          try {
            const mem = await categoryMembers(
              origin,
              c.name,
              "page",
              isFinite(perCategory) ? perCategory : Infinity
            );
            titles = mem.filter((m) => m.ns === 0).map((m) => m.title);
          } catch {
            return;
          }
          if (titles.length < MIN_MEMBERS_FOR_GROUP) return;
          send("group", {
            gid,
            category: c.name,
            totalMembers: c.pages,
            titles,
          });
        });
      } catch (e: any) {
        send("error", { error: String(e?.message || e) });
      } finally {
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: done\ndata: {}\n\n`)
          );
        } catch { /* */ }
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function normalizeBudget(v: any, fallback: number): number {
  if (v === "unlimited" || v === Infinity) return Infinity;
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback || Infinity;
  if (n <= 0) return Infinity;
  return Math.min(Math.floor(n), 100000);
}

async function siteInfoPlus(origin: string) {
  try {
    const j = await mwGet<any>(origin, {
      action: "query",
      meta: "siteinfo",
      siprop: "general|statistics",
    });
    const g = j?.query?.general || {};
    const s = j?.query?.statistics || {};
    return {
      mainpage: g.mainpage || "Main Page",
      sitename: g.sitename || "",
      articles: Number(s.articles) || 0,
    };
  } catch {
    return { mainpage: "Main Page", sitename: "", articles: 0 };
  }
}

function isAdminCategory(name: string): boolean {
  return /^(hidden|tracking|stub|stubs|article stubs|candidates for|pages|maintenance|wiki|wikia|community|admin|blog posts|files|images|videos|galleries|templates?|infobox templates?|disambig|redirects?|needs?|lists?|articles needing|articles with|all articles|browse|contents|help|policy|site|special|categories|pages? with|pages? using|tracking categories)\b/i.test(name);
}

async function runPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      try { await fn(items[cur]); } catch { /* */ }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}
