// app/api/profile/run/route.ts
// Internal worker endpoint. Runs one chunk of work for a job, then — if more
// work remains — fires a fresh fetch to itself so we stay under Vercel's
// per-invocation time limit without losing progress.
import { NextRequest, NextResponse, after } from "next/server";
import { runChunk } from "@/lib/profiler/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId)
    return NextResponse.json({ error: "jobId required" }, { status: 400 });

  try {
    const res = await runChunk(jobId);
    if (!res.done) {
      // Self-reinvoke by running another chunk in the background of *this*
      // invocation via after(). Vercel will extend the lifetime to let it
      // finish. Loop a few times to amortize cold-start cost, up to a soft
      // cap — then let the UI watchdog pick up any remaining work.
      after(async () => {
        try {
          for (let i = 0; i < 8; i++) {
            const r = await runChunk(jobId);
            if (r.done) break;
          }
        } catch (e: any) {
          // error already persisted by runChunk
        }
      });
    }
    return NextResponse.json(res);
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "worker failed" },
      { status: 500 }
    );
  }
}

// GET is convenient for manual resumption from a browser.
export async function GET(req: NextRequest) {
  return POST(req);
}
