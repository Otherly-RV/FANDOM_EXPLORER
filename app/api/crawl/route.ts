// app/api/crawl/route.ts
// Returns REAL structural data for a Fandom page (links, categories, sections,
// infobox) from the MediaWiki API — never from an LLM.
// Optionally attaches a NARRATIVE brief (summary + key facts) produced by the
// chosen LLM provider from the page's own real first paragraph.
import { NextRequest, NextResponse } from "next/server";
import { fetchFandomPage } from "@/lib/fandom";
import { extractBrief, LLMProvider } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseProvider(v: string | null): LLMProvider {
  if (v === "claude" || v === "gemini" || v === "none") return v;
  return "none";
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
  const provider = parseProvider(req.nextUrl.searchParams.get("provider"));

  try {
    const data = await fetchFandomPage(url);

    // Structure is already real. The LLM only rewrites the narrative paragraph.
    if (provider !== "none" && data.summary) {
      const brief = await extractBrief(provider, data.title, data.summary);
      if (brief) {
        return NextResponse.json({
          ...data,
          summary: brief.summary || data.summary,
          keyFacts: brief.keyFacts,
          aiProvider: brief.provider,
          aiModel: brief.model,
        });
      }
    }
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "fetch failed" }, { status: 500 });
  }
}
