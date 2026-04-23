// app/api/providers/route.ts
// Tells the client which LLM providers have server-side keys configured,
// plus the default model IDs. The keys themselves never leave the server.
import { NextResponse } from "next/server";
import { availableProviders } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    providers: availableProviders(),
    defaults: {
      claude: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      gemini: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
    },
  });
}
