// app/api/profile/route.ts
// POST { origin | url, refresh? } -> starts a profiling job (or returns existing)
// GET  ?origin=...                -> returns the cached profile (or 404)
import { NextRequest, NextResponse } from "next/server";
import { parseFandomOrigin } from "@/lib/mw";
import {
  createJob,
  findActiveJob,
  getProfile,
} from "@/lib/profiler/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function newId(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

export async function GET(req: NextRequest) {
  const originRaw = req.nextUrl.searchParams.get("origin") || "";
  try {
    const origin = originRaw.includes("/wiki/")
      ? parseFandomOrigin(originRaw)
      : new URL(originRaw).origin;
    try {
      const row = await getProfile(origin);
      if (!row) return NextResponse.json({ cached: false }, { status: 404 });
      return NextResponse.json({ cached: true, profile: row });
    } catch (dbErr: any) {
      // Most common cause: schema not migrated yet on this DB.
      const msg = String(dbErr?.message || dbErr);
      const needsMigrate = /wiki_profiles|relation .* does not exist/i.test(msg);
      return NextResponse.json(
        {
          cached: false,
          error: needsMigrate
            ? "DB not migrated — run /api/admin/migrate"
            : msg,
          needsMigrate,
        },
        { status: 500 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "bad origin" },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty */
  }
  const raw: string = body.origin || body.url || "";
  const refresh = Boolean(body.refresh);
  if (!raw)
    return NextResponse.json({ error: "origin or url required" }, { status: 400 });

  let origin: string;
  try {
    origin = raw.includes("/wiki/")
      ? parseFandomOrigin(raw)
      : new URL(raw).origin;
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "invalid URL" },
      { status: 400 }
    );
  }

  // If a fresh profile exists and refresh not requested → nothing to do.
  if (!refresh) {
    const existing = await getProfile(origin);
    if (existing) {
      return NextResponse.json({
        origin,
        status: "done",
        cached: true,
        profile: existing,
      });
    }
    // If a job is already running, return it.
    const active = await findActiveJob(origin);
    if (active) {
      return NextResponse.json({
        origin,
        status: active.status,
        jobId: active.id,
        cached: false,
      });
    }
  }

  const jobId = newId();
  await createJob(jobId, origin);

  // Fire-and-forget kick the worker. Don't await.
  const runUrl = new URL("/api/profile/run", req.nextUrl.origin);
  runUrl.searchParams.set("jobId", jobId);
  fetch(runUrl.toString(), { method: "POST" }).catch(() => {});

  return NextResponse.json({ origin, status: "queued", jobId, cached: false });
}
