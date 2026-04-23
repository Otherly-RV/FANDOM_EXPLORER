// app/api/profile/status/route.ts
// GET ?jobId=...  -> job progress row
// GET ?origin=... -> latest job for an origin + cached profile presence
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getJob, getProfile } from "@/lib/profiler/cache";
import { parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (jobId) {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Strip resume_state from the public response.
    const { resume_state: _rs, ...rest } = job;
    return NextResponse.json({ job: rest });
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
    sql`SELECT id, status, phase, pages_seen, categories_seen, hubs_seen, pct, error, updated_at
        FROM profile_jobs WHERE origin = ${origin}
        ORDER BY created_at DESC LIMIT 1` as any,
    getProfile(origin),
  ]);
  return NextResponse.json({
    origin,
    job: (jobs as any[])[0] ?? null,
    cached: Boolean(profile),
    profile: profile ?? null,
  });
}
