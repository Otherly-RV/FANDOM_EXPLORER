// app/api/canon/analyze/route.ts
// POST { origin, provider: "gemini"|"claude", model? }
//   -> { tree: CanonNode[], explanation: string (markdown), meta }
//
// The system gathers real structural signals from the wiki:
//   • sitename / main page first paragraphs
//   • MediaWiki:Wiki-navigation tree (the editors' own top menu)
//   • top categories by member count (what's big in this IP)
// and asks the chosen LLM to explain how THIS Fandom community
// organizes its CANON (canonicity policy, tiers, eras, media-of-origin,
// continuity branches, etc.) without reorganizing anything.
import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import {
  allCategoriesBySize,
  mwGet,
  parseFandomOrigin,
  siteInfo,
} from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Provider = "gemini" | "claude";

type CanonNode = { label: string; note?: string; children?: CanonNode[] };
type AnalyzeOut = { tree: CanonNode[]; explanation: string };

// --- model allow-list (safety: never pass arbitrary user strings) ---------
const MODELS: Record<Provider, string[]> = {
  gemini: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
  claude: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
  ],
};
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-3.1-pro-preview",
  claude: "claude-sonnet-4-6",
};

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* */
  }
  const rawOrigin: string = body.origin || body.url || "";
  const provider: Provider = body.provider === "claude" ? "claude" : "gemini";
  const requestedModel: string | undefined = body.model;
  if (!rawOrigin)
    return NextResponse.json({ error: "origin required" }, { status: 400 });

  let origin: string;
  try {
    origin = rawOrigin.includes("/wiki/")
      ? parseFandomOrigin(rawOrigin)
      : new URL(rawOrigin).origin;
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "bad origin" },
      { status: 400 }
    );
  }

  const model =
    requestedModel && MODELS[provider].includes(requestedModel)
      ? requestedModel
      : DEFAULT_MODEL[provider];

  try {
    const ctx = await gatherContext(origin);
    const out = await callLLM(provider, model, ctx);
    return NextResponse.json({
      origin,
      provider,
      model,
      tree: out.tree,
      explanation: out.explanation,
      meta: {
        sitename: ctx.sitename,
        mainpage: ctx.mainpage,
        navCount: ctx.navCount,
        topCategories: ctx.topCategories.length,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

// =========================================================================
// Context gathering — compact, grounded in real wiki data.
// =========================================================================

type Context = {
  origin: string;
  sitename: string;
  mainpage: string;
  mainpageLead: string;
  navLines: string[]; // indented lines like "  Games > Street Fighter 6"
  navCount: number;
  topCategories: { name: string; pages: number }[];
};

async function gatherContext(origin: string): Promise<Context> {
  const info = await siteInfo(origin).catch(() => ({
    mainpage: "Main Page",
    sitename: "",
    lang: "en",
  }));

  const [navLines, navCount] = await fetchNavLines(origin);
  const mainpageLead = await fetchMainPageLead(origin, info.mainpage);
  const topRaw = await allCategoriesBySize(origin, { maxCategories: 2000, minPages: 3 }).catch(() => []);
  const topCategories = topRaw.slice(0, 40).map((c) => ({ name: c.name, pages: c.pages }));

  return {
    origin,
    sitename: info.sitename || new URL(origin).hostname,
    mainpage: info.mainpage,
    mainpageLead,
    navLines,
    navCount,
    topCategories,
  };
}

async function fetchNavLines(origin: string): Promise<[string[], number]> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: "MediaWiki:Wiki-navigation",
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  const wikitext: string = j?.parse?.wikitext || "";
  if (!wikitext) return [[], 0];
  const lines: string[] = [];
  for (const raw of wikitext.split(/\r?\n/)) {
    const m = raw.match(/^(\*+)\s*(.+)$/);
    if (!m) continue;
    const depth = m[1].length - 1;
    let label = m[2].trim();
    // Accept: "Target|Label", "[[Target|Label]]", bare label
    label = label.replace(/^\[\[|\]\]$/g, "");
    const pipe = label.indexOf("|");
    if (pipe >= 0) label = label.slice(pipe + 1).trim();
    if (!label) continue;
    lines.push("  ".repeat(depth) + label);
  }
  return [lines, lines.length];
}

async function fetchMainPageLead(
  origin: string,
  mainpage: string
): Promise<string> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: mainpage,
    prop: "text",
    redirects: 1,
  }).catch(() => null);
  const html: string = j?.parse?.text?.["*"] || j?.parse?.text || "";
  if (!html) return "";
  const $ = cheerio.load(html);
  $("script,style,.navbox,.mw-editsection,.reference,table").remove();
  const paras: string[] = [];
  $("p").each((_, p) => {
    const t = $(p).text().replace(/\s+/g, " ").trim();
    if (t.length > 40) paras.push(t);
  });
  return paras.slice(0, 4).join("\n\n").slice(0, 2500);
}

// =========================================================================
// LLM call — returns strict JSON { tree, explanation }.
// =========================================================================

const SYSTEM = [
  "You are a media-franchise analyst studying a Fandom wiki.",
  "Your task: explain how THIS particular IP's community organizes its CANON.",
  "",
  "SCOPE:",
  "- CANON here means: what the wiki treats as in-universe authoritative, and how.",
  "- Examples of things to surface: canon tiers (e.g. main-canon / side-canon / non-canon),",
  "  continuity branches (reboots, alternate timelines, multiverses),",
  "  eras / time periods, media of origin (film / manga / game / novel / ...),",
  "  character-status policies, dual-continuity handling (e.g. Legends vs Disney Canon),",
  "  how contradictions are reconciled.",
  "- DO NOT propose a reorganization. DO NOT invent policies the wiki does not show.",
  "- If the wiki's canon logic is shallow or implicit, say so plainly.",
  "",
  "GROUNDING:",
  "- Base your answer ONLY on the context block provided (sitename, main-page lead,",
  "  editor navigation menu, top categories by size). Do not cite outside knowledge.",
  "- If a pattern is only inferred from category names, mark it as inferred.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the JSON:",
  "{",
  '  "tree": CanonNode[],',
  '  "explanation": string   // markdown, 250–600 words',
  "}",
  "CanonNode = { label: string, note?: string, children?: CanonNode[] }",
  "- tree depicts the canon ORGANIZATION of this IP (tiers / eras / continuities / media).",
  "- Keep tree to at most 4 levels deep and ~40 nodes total.",
  "- Each `note` is <= 15 words and describes what that branch means in-universe.",
  "- explanation describes the META logic: why it's shaped this way, who decides,",
  "  what the signals are, where the grey areas are.",
].join("\n");

function userMsg(ctx: Context): string {
  const nav = ctx.navLines.slice(0, 150).join("\n") || "(no MediaWiki:Wiki-navigation defined)";
  const cats = ctx.topCategories
    .slice(0, 40)
    .map((c) => `- ${c.name} (${c.pages})`)
    .join("\n") || "(none)";
  return [
    `Wiki: ${ctx.sitename}`,
    `Origin: ${ctx.origin}`,
    `Main page: ${ctx.mainpage}`,
    "",
    "=== MAIN PAGE LEAD (verbatim) ===",
    ctx.mainpageLead || "(empty)",
    "",
    "=== EDITOR NAVIGATION MENU (MediaWiki:Wiki-navigation) ===",
    nav,
    "",
    "=== TOP CATEGORIES BY MEMBER COUNT ===",
    cats,
    "",
    "Return ONLY the JSON object.",
  ].join("\n");
}

async function callLLM(
  provider: Provider,
  model: string,
  ctx: Context
): Promise<AnalyzeOut> {
  if (provider === "claude") return await callClaude(model, ctx);
  return await callGemini(model, ctx);
}

async function callClaude(model: string, ctx: Context): Promise<AnalyzeOut> {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("CLAUDE_API_KEY not set");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg(ctx) }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const txt = (j.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return parseAnalyzeJson(txt);
}

async function callGemini(model: string, ctx: Context): Promise<AnalyzeOut> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userMsg(ctx) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
        maxOutputTokens: 4000,
      },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const txt = (j.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p.text || "")
    .join("");
  return parseAnalyzeJson(txt);
}

function parseAnalyzeJson(txt: string): AnalyzeOut {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM did not return JSON");
  let o: any;
  try {
    o = JSON.parse(m[0]);
  } catch (e: any) {
    throw new Error("LLM returned invalid JSON: " + e.message);
  }
  const tree = Array.isArray(o.tree) ? sanitizeTree(o.tree, 0) : [];
  const explanation =
    typeof o.explanation === "string" ? o.explanation : "";
  return { tree, explanation };
}

function sanitizeTree(nodes: any[], depth: number): CanonNode[] {
  if (depth > 5) return [];
  const out: CanonNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n.label !== "string" || !n.label.trim()) continue;
    const node: CanonNode = { label: n.label.trim().slice(0, 120) };
    if (typeof n.note === "string" && n.note.trim())
      node.note = n.note.trim().slice(0, 200);
    if (Array.isArray(n.children) && n.children.length) {
      node.children = sanitizeTree(n.children, depth + 1);
    }
    out.push(node);
    if (out.length >= 50) break;
  }
  return out;
}
