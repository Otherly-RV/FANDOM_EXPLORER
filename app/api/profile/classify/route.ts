// app/api/profile/classify/route.ts
// POST { origin, titles:[...] } -> classify the given page titles on-demand
// GET  ?origin=...&title=...    -> classify a single title
import { NextRequest, NextResponse } from "next/server";
import { parseFandomOrigin } from "@/lib/mw";
import { classifyPages } from "@/lib/profiler/classify";
import { getProfile } from "@/lib/profiler/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function resolveOrigin(raw: string): Promise<string> {
  return raw.includes("/wiki/")
    ? parseFandomOrigin(raw)
    : new URL(raw).origin;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rawOrigin: string = body.origin || "";
  const titles: string[] = Array.isArray(body.titles) ? body.titles : [];
  if (!rawOrigin || titles.length === 0)
    return NextResponse.json(
      { error: "origin and titles[] required" },
      { status: 400 }
    );
  try {
    const origin = await resolveOrigin(rawOrigin);
    const profile = await getProfile(origin);
    if (!profile)
      return NextResponse.json(
        { error: "profile not found; run /api/profile first" },
        { status: 404 }
      );
    const records = await classifyPages(origin, titles, profile.canon_policy);
    return NextResponse.json({ origin, records });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "classify failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const rawOrigin = req.nextUrl.searchParams.get("origin") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  if (!rawOrigin || !title)
    return NextResponse.json(
      { error: "origin and title required" },
      { status: 400 }
    );
  try {
    const origin = await resolveOrigin(rawOrigin);
    const profile = await getProfile(origin);
    if (!profile)
      return NextResponse.json(
        { error: "profile not found; run /api/profile first" },
        { status: 404 }
      );
    const [rec] = await classifyPages(origin, [title], profile.canon_policy);
    return NextResponse.json({ origin, record: rec ?? null });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "classify failed" },
      { status: 500 }
    );
  }
}
