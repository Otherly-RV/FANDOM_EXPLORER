// app/api/canon/analyze/route.ts
// POST { origin, provider: "gemini"|"claude", model? }
//   -> { tree, explanation, perType, provider, model, meta }
//
// Gathers a BROAD, GROUNDED fingerprint of the wiki:
//   1. siteinfo (name / main page / lang / # of articles)
//   2. MediaWiki:Wiki-navigation (editor menu, full tree)
//   3. main-page lead paragraphs
//   4. top ~80 categories by member count
//   5. for each of the top ~20 categories: a sample of member titles
//   6. for a representative set of ~30 pages (drawn from 3–5):
//        - infobox template name + field keys (what attributes exist)
//        - section headings (TOC)
//        - categories assigned
//   7. canon-signal categories: anything matching canon / legends / era /
//      continuity / timeline / reboot / multiverse / alternate / non-canon /
//      retcon / appendix — captured verbatim so the LLM can recognize them.
//
// The LLM is asked to explain how THIS IP's canon is organized, and to
// produce a per-type schema (what fields a "Character" page carries, etc.).

import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import {
  allCategoriesBySize,
  categoryMembers,
  mwGet,
  parseFandomOrigin,
  siteInfo,
} from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Provider = "gemini" | "claude";

type CanonNode = { label: string; note?: string; children?: CanonNode[] };
type TypeSchema = {
  type: string; // e.g. "Character"
  template?: string; // e.g. "Infobox character"
  fields: string[]; // infobox keys observed
  commonSections: string[]; // section headings observed
  categoryAxes: string[]; // axes derived from categories
  examples: string[]; // example page titles
  notes?: string; // LLM commentary
};
type AnalyzeOut = {
  tree: CanonNode[];
  explanation: string;
  perType: TypeSchema[];
};

const MODELS: Record<Provider, string[]> = {
  gemini: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
  claude: ["claude-opus-4-7", "claude-sonnet-4-6"],
};
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-3.1-pro-preview",
  claude: "claude-sonnet-4-6",
};

// Hard-cap the sampling so one call stays within the LLM context budget.
const TOP_CATEGORIES = 80;
const SAMPLED_CATEGORIES = 20;
const MEMBERS_PER_CATEGORY = 12;
const DETAILED_PAGES = 30;

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
      perType: out.perType,
      meta: {
        sitename: ctx.sitename,
        mainpage: ctx.mainpage,
        articles: ctx.articles,
        navCount: ctx.navCount,
        topCategories: ctx.topCategories.length,
        detailedPages: ctx.pageDetails.length,
        canonSignalCategories: ctx.canonSignalCategories.length,
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
// Context gathering
// =========================================================================

type Context = {
  origin: string;
  sitename: string;
  mainpage: string;
  articles: number;
  mainpageLead: string;
  navLines: string[];
  navCount: number;
  topCategories: { name: string; pages: number; subcats: number }[];
  canonSignalCategories: { name: string; pages: number }[];
  categorySamples: { category: string; members: string[] }[];
  pageDetails: PageDetail[];
};

type PageDetail = {
  title: string;
  template?: string;
  fields: string[];
  sections: string[];
  categories: string[];
};

async function gatherContext(origin: string): Promise<Context> {
  const [info, navData, categoriesRaw] = await Promise.all([
    siteInfoPlus(origin),
    fetchNav(origin),
    allCategoriesBySize(origin, { maxCategories: 4000, minPages: 3 }).catch(
      () => []
    ),
  ]);

  const mainpageLead = await fetchMainPageLead(origin, info.mainpage);

  const topCategories = categoriesRaw
    .slice(0, TOP_CATEGORIES)
    .map((c) => ({ name: c.name, pages: c.pages, subcats: c.subcats }));

  const canonSignalCategories = categoriesRaw
    .filter((c) => /canon|legends|non[- ]?canon|retcon|continuity|timeline|reboot|multiverse|alternate|era|age|chronolog|appendix|ambiguous|disputed/i.test(c.name))
    .slice(0, 40)
    .map((c) => ({ name: c.name, pages: c.pages }));

  // Sample members of the top-N categories to see what fills them.
  const categoriesToSample = categoriesRaw.slice(0, SAMPLED_CATEGORIES);
  const categorySamples = await mapLimited(
    categoriesToSample,
    4,
    async (c) => {
      const mem = await categoryMembers(
        origin,
        c.name,
        "page",
        MEMBERS_PER_CATEGORY
      ).catch(() => []);
      return {
        category: c.name,
        members: mem
          .filter((m) => m.ns === 0)
          .map((m) => m.title)
          .slice(0, MEMBERS_PER_CATEGORY),
      };
    }
  );

  // Pick representative pages for deep inspection.
  // Round-robin across the top categories' samples to avoid one category
  // dominating the sample.
  const pickedTitles = pickRoundRobin(
    categorySamples.map((s) => s.members),
    DETAILED_PAGES
  );

  const pageDetails = await mapLimited(pickedTitles, 5, (t) =>
    fetchPageDetail(origin, t)
  );

  return {
    origin,
    sitename: info.sitename || new URL(origin).hostname,
    mainpage: info.mainpage,
    articles: info.articles,
    mainpageLead,
    navLines: navData.lines,
    navCount: navData.count,
    topCategories,
    canonSignalCategories,
    categorySamples,
    pageDetails: pageDetails.filter(Boolean) as PageDetail[],
  };
}

async function siteInfoPlus(origin: string) {
  try {
    const j = await mwGet<any>(origin, {
      action: "query",
      meta: "siteinfo",
      siprop: "general|statistics",
    });
    const g = j?.query?.general || {};
    const s = j?.query?.statistics || {};
    return {
      mainpage: g.mainpage || "Main Page",
      sitename: g.sitename || "",
      lang: g.lang || "en",
      articles: Number(s.articles) || 0,
    };
  } catch {
    return { mainpage: "Main Page", sitename: "", lang: "en", articles: 0 };
  }
}

async function fetchNav(
  origin: string
): Promise<{ lines: string[]; count: number }> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: "MediaWiki:Wiki-navigation",
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  const wikitext: string = j?.parse?.wikitext || "";
  if (!wikitext) return { lines: [], count: 0 };
  const lines: string[] = [];
  for (const raw of wikitext.split(/\r?\n/)) {
    const m = raw.match(/^(\*+)\s*(.+)$/);
    if (!m) continue;
    const depth = m[1].length - 1;
    let label = m[2].trim();
    label = label.replace(/^\[\[|\]\]$/g, "");
    const pipe = label.indexOf("|");
    if (pipe >= 0) label = label.slice(pipe + 1).trim();
    if (!label) continue;
    lines.push("  ".repeat(depth) + label);
  }
  return { lines, count: lines.length };
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
  return paras.slice(0, 6).join("\n\n").slice(0, 3000);
}

// Fetch one page's infobox template + field keys + sections + categories.
async function fetchPageDetail(
  origin: string,
  title: string
): Promise<PageDetail | null> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: title,
    prop: "wikitext|sections|categories",
    redirects: 1,
  }).catch(() => null);
  if (!j?.parse) return null;
  const wikitext: string = j.parse.wikitext?.["*"] || j.parse.wikitext || "";
  const { template, fields } = extractInfoboxFields(wikitext);
  const sections: string[] = (j.parse.sections || [])
    .map((s: any) => String(s.line || "").replace(/<[^>]+>/g, ""))
    .filter(Boolean)
    .slice(0, 20);
  const categories: string[] = (j.parse.categories || [])
    .map((c: any) => String(c["*"] || c.category || "").replace(/_/g, " "))
    .filter((c: string) => c && !/^(Hidden|Tracking)/i.test(c))
    .slice(0, 30);
  return {
    title: j.parse.title || title,
    template,
    fields,
    sections,
    categories,
  };
}

// Extract the first {{Infobox ...}} template's field keys.
function extractInfoboxFields(wikitext: string): {
  template?: string;
  fields: string[];
} {
  if (!wikitext) return { fields: [] };
  // Find `{{Infobox ...}}` or `{{SomethingInfobox ...}}` balanced to its close.
  const startRe = /\{\{\s*([^|{}\n]*\binfobox\b[^|{}\n]*)/i;
  const startMatch = startRe.exec(wikitext);
  if (!startMatch) return { fields: [] };
  const name = startMatch[1].trim();
  // Balance braces to find end.
  let i = startMatch.index;
  let depth = 0;
  let end = -1;
  for (; i < wikitext.length; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
      depth++;
      i++;
    } else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return { template: name, fields: [] };
  const body = wikitext.slice(startMatch.index, end);
  // Split on top-level pipes (ignore pipes inside nested [[...]] or {{...}}).
  const fields = splitTopLevelPipes(body)
    .slice(1) // first chunk is "{{Infobox name"
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return null;
      const k = p.slice(0, eq).trim();
      if (!k || k.length > 40 || /[\n{}]/.test(k)) return null;
      return k;
    })
    .filter((k): k is string => !!k);
  return { template: name, fields: dedupe(fields).slice(0, 40) };
}

function splitTopLevelPipes(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let link = 0;
  let tmpl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === "[" && c2 === "[") {
      link++;
      buf += "[[";
      i++;
      continue;
    }
    if (c === "]" && c2 === "]") {
      link--;
      buf += "]]";
      i++;
      continue;
    }
    if (c === "{" && c2 === "{") {
      tmpl++;
      buf += "{{";
      i++;
      continue;
    }
    if (c === "}" && c2 === "}") {
      tmpl--;
      buf += "}}";
      i++;
      continue;
    }
    if (c === "|" && link === 0 && tmpl === 1) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function pickRoundRobin(lists: string[][], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let changed = true;
  let idx = 0;
  while (changed && out.length < max) {
    changed = false;
    for (const lst of lists) {
      const t = lst[idx];
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
        changed = true;
        if (out.length >= max) break;
      }
    }
    idx++;
  }
  return out;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      try {
        out[cur] = await fn(items[cur]);
      } catch {
        out[cur] = undefined as any;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

// =========================================================================
// LLM
// =========================================================================

const SYSTEM = [
  "You are a media-franchise analyst studying a single Fandom wiki.",
  "Your ONLY job is to describe — not prescribe — how THIS IP's community",
  "organizes its canon.",
  "",
  "WHAT THE USER WANTS:",
  "1. A hierarchical tree of the canon's ORGANIZATION (tiers / continuities /",
  "   eras / media / factions — whatever the wiki actually uses).",
  "2. A prose META-EXPLANATION of the organizing logic: what signals the wiki",
  "   uses to classify a work as canon, how it handles reboots / alternate",
  "   continuities / retcons / expanded media / non-canon spinoffs.",
  "3. A PER-TYPE SCHEMA: for each major item type found on the wiki",
  "   (Character, Location, Episode, Game, Faction, Weapon, Event, etc.)",
  "   list the infobox template used and the FIELDS (attributes) the wiki",
  "   tracks for that type, plus the common section headings, plus the",
  "   categorization axes the wiki slices that type along.",
  "",
  "RULES:",
  "- Ground EVERY claim in the context block. Do not invent policies,",
  "  tiers, or fields. If the wiki is shallow, say so.",
  "- Quote category names verbatim when citing them.",
  "- Field names MUST come from the observed infobox keys in the sample.",
  "- Do not propose reorganization. Describe what exists.",
  "- Be precise; avoid generic filler.",
  "",
  "OUTPUT — STRICT JSON, nothing outside the JSON:",
  "{",
  '  "tree": CanonNode[],          // canon organization: up to 5 levels, ~60 nodes',
  '  "explanation": string,        // markdown, 500–1200 words, meta-logic',
  '  "perType": TypeSchema[]       // 4–12 types',
  "}",
  "CanonNode  = { label: string, note?: string (<=20 words), children?: CanonNode[] }",
  "TypeSchema = {",
  '  type: string,                 // e.g. "Character", "Game", "Location"',
  '  template?: string,            // observed infobox template name',
  '  fields: string[],             // infobox keys (verbatim as observed)',
  '  commonSections: string[],     // section headings typical for this type',
  '  categoryAxes: string[],       // axes like "by status", "by game", "by affiliation"',
  '  examples: string[],           // 2–5 example page titles from the sample',
  '  notes?: string                // <=40 words of commentary',
  "}",
].join("\n");

function userMsg(ctx: Context): string {
  const nav = ctx.navLines.slice(0, 200).join("\n") || "(no MediaWiki:Wiki-navigation defined)";

  const topCats =
    ctx.topCategories
      .map((c) => `- ${c.name} (${c.pages} pages, ${c.subcats} subcats)`)
      .join("\n") || "(none)";

  const canonSig =
    ctx.canonSignalCategories.length > 0
      ? ctx.canonSignalCategories
          .map((c) => `- ${c.name} (${c.pages})`)
          .join("\n")
      : "(none found — the wiki may not use explicit canon-policy categories)";

  const samples = ctx.categorySamples
    .map(
      (s) =>
        `# ${s.category}\n${s.members.map((m) => `  - ${m}`).join("\n") || "  (empty)"}`
    )
    .join("\n\n");

  const details = ctx.pageDetails
    .map((p) => {
      const tmpl = p.template ? ` [template: ${p.template}]` : "";
      const fields = p.fields.length
        ? `\n  fields: ${p.fields.join(", ")}`
        : "\n  fields: (none observed)";
      const secs = p.sections.length
        ? `\n  sections: ${p.sections.join(" | ")}`
        : "";
      const cats = p.categories.length
        ? `\n  categories: ${p.categories.join(", ")}`
        : "";
      return `- ${p.title}${tmpl}${fields}${secs}${cats}`;
    })
    .join("\n");

  return [
    `Wiki: ${ctx.sitename}`,
    `Origin: ${ctx.origin}`,
    `Articles (ns=0): ${ctx.articles}`,
    `Main page: ${ctx.mainpage}`,
    "",
    "=== MAIN PAGE LEAD (verbatim) ===",
    ctx.mainpageLead || "(empty)",
    "",
    "=== EDITOR NAVIGATION MENU (MediaWiki:Wiki-navigation) ===",
    nav,
    "",
    `=== TOP ${ctx.topCategories.length} CATEGORIES BY PAGE COUNT ===`,
    topCats,
    "",
    "=== CATEGORIES MATCHING CANON-POLICY KEYWORDS ===",
    canonSig,
    "",
    "=== SAMPLE MEMBERS PER TOP CATEGORY ===",
    samples,
    "",
    `=== DETAILED PAGE FINGERPRINTS (${ctx.pageDetails.length} pages) ===`,
    "For each page: infobox template name, infobox field keys, section headings, and assigned categories.",
    details,
    "",
    "Produce the JSON object described in the system prompt.",
  ].join("\n");
}

async function callLLM(
  provider: Provider,
  model: string,
  ctx: Context
): Promise<AnalyzeOut> {
  if (provider === "claude") return callClaude(model, ctx);
  return callGemini(model, ctx);
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
      max_tokens: 8000,
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
        temperature: 0.25,
        maxOutputTokens: 8000,
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
  return {
    tree: Array.isArray(o.tree) ? sanitizeTree(o.tree, 0) : [],
    explanation: typeof o.explanation === "string" ? o.explanation : "",
    perType: Array.isArray(o.perType) ? sanitizeTypes(o.perType) : [],
  };
}

function sanitizeTree(nodes: any[], depth: number): CanonNode[] {
  if (depth > 6) return [];
  const out: CanonNode[] = [];
  for (const n of nodes) {
    if (!n || typeof n.label !== "string" || !n.label.trim()) continue;
    const node: CanonNode = { label: n.label.trim().slice(0, 140) };
    if (typeof n.note === "string" && n.note.trim())
      node.note = n.note.trim().slice(0, 240);
    if (Array.isArray(n.children) && n.children.length)
      node.children = sanitizeTree(n.children, depth + 1);
    out.push(node);
    if (out.length >= 80) break;
  }
  return out;
}

function sanitizeTypes(raw: any[]): TypeSchema[] {
  const out: TypeSchema[] = [];
  for (const t of raw) {
    if (!t || typeof t.type !== "string" || !t.type.trim()) continue;
    out.push({
      type: t.type.trim().slice(0, 60),
      template:
        typeof t.template === "string" && t.template.trim()
          ? t.template.trim().slice(0, 80)
          : undefined,
      fields: strArray(t.fields, 50, 60),
      commonSections: strArray(t.commonSections, 30, 80),
      categoryAxes: strArray(t.categoryAxes, 20, 80),
      examples: strArray(t.examples, 10, 120),
      notes:
        typeof t.notes === "string" && t.notes.trim()
          ? t.notes.trim().slice(0, 400)
          : undefined,
    });
    if (out.length >= 20) break;
  }
  return out;
}

function strArray(v: any, maxLen: number, itemMax: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.trim().slice(0, itemMax);
    if (t) out.push(t);
    if (out.length >= maxLen) break;
  }
  return out;
}
