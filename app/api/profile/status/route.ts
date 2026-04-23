// app/api/profile/status/route.ts
// GET ?jobId=...  -> job progress row
// GET ?origin=... -> latest job for an origin + cached profile presence
// Also acts as a watchdog: if a job is queued/running but hasn't heartbeat
// in >30s, kick /api/profile/run again so we recover from any lost
// background task (Vercel cold-evict, transient error, etc).
import { NextRequest, NextResponse, after } from "next/server";
import { sql } from "@/lib/db";
import { getJob, getProfile } from "@/lib/profiler/cache";
import { parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_MS = 30_000;

function reviveIfStale(req: NextRequest, job: any) {
  if (!job) return false;
  if (job.status !== "queued" && job.status !== "running") return false;
  const hb = job.heartbeat_at ? new Date(job.heartbeat_at).getTime() : 0;
  if (Date.now() - hb < STALE_MS) return false;
  const runUrl = new URL("/api/profile/run", req.nextUrl.origin);
  runUrl.searchParams.set("jobId", job.id);
  after(async () => {
    await fetch(runUrl.toString(), { method: "POST" }).catch(() => {});
  });
  return true;
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (jobId) {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    const revived = reviveIfStale(req, job);
    const { resume_state: _rs, ...rest } = job;
    const hb = rest.heartbeat_at
      ? Math.max(0, Math.floor((Date.now() - new Date(rest.heartbeat_at).getTime()) / 1000))
      : null;
    return NextResponse.json({ job: { ...rest, heartbeat_age_s: hb, revived } });
  }

  const originRaw = req.nextUrl.searchParams.get("origin") || "";
  if (!originRaw)
    return NextResponse.json(
      { error: "jobId or origin required" },
      { status: 400 }
    );
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

  const [jobs, profile] = await Promise.all([
    sql`SELECT id, origin, status, phase, pages_seen, categories_seen, hubs_seen, pct, error, heartbeat_at, updated_at
        FROM profile_jobs WHERE origin = ${origin}
        ORDER BY created_at DESC LIMIT 1` as any,
    getProfile(origin),
  ]);
  const job = (jobs as any[])[0] ?? null;
  const revived = reviveIfStale(req, job);
  const hb = job?.heartbeat_at
    ? Math.max(0, Math.floor((Date.now() - new Date(job.heartbeat_at).getTime()) / 1000))
    : null;
  return NextResponse.json({
    origin,
    job: job ? { ...job, heartbeat_age_s: hb, revived } : null,
    cached: Boolean(profile),
    profile: profile ?? null,
  });
}
