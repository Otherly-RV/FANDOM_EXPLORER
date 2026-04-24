// app/api/canon/snapshots/[id]/pages/route.ts
// Append a batch of pages (typically one chunk of ~20) to an existing snapshot.
// Called repeatedly during a scan so we never POST a giant payload.
import { NextResponse } from "next/server";
import { sql, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type IncomingPage = {
  gid: number;
  title: string;
  url: string;
  template?: string | null;
  fields?: [string, string][];
  lead?: string;
  sections?: { heading: string; level: number; text: string }[];
};

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    await ensureSchema();
    const body = await req.json();
    const pages: IncomingPage[] = Array.isArray(body?.pages) ? body.pages : [];
    if (!pages.length) return NextResponse.json({ ok: true, inserted: 0 });
    // Insert one-by-one with ON CONFLICT so mid-scan resumes are idempotent.
    let inserted = 0;
    for (const p of pages) {
      if (!p || typeof p.gid !== "number" || !p.title || !p.url) continue;
      await sql`
        INSERT INTO canon_pages
          (snapshot_id, gid, title, url, template, fields, lead, sections)
        VALUES (
          ${id}, ${p.gid}, ${p.title}, ${p.url},
          ${p.template || null},
          ${JSON.stringify(p.fields || [])}::jsonb,
          ${p.lead || ""},
          ${JSON.stringify(p.sections || [])}::jsonb
        )
        ON CONFLICT (snapshot_id, gid, title) DO UPDATE SET
          url = EXCLUDED.url,
          template = EXCLUDED.template,
          fields = EXCLUDED.fields,
          lead = EXCLUDED.lead,
          sections = EXCLUDED.sections
      `;
      inserted++;
    }
    await sql`UPDATE canon_snapshots SET updated_at = now() WHERE id = ${id}`;
    return NextResponse.json({ ok: true, inserted });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
