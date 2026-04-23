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
      // Self-reinvoke via after() so Vercel doesn't cancel the outgoing fetch.
      const runUrl = new URL("/api/profile/run", req.nextUrl.origin);
      runUrl.searchParams.set("jobId", jobId);
      after(async () => {
        await fetch(runUrl.toString(), { method: "POST" }).catch(() => {});
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
