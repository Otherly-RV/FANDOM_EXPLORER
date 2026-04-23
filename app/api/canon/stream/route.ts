// app/api/canon/stream/route.ts
// POST { origin, provider, model } -> Server-Sent Events stream.
// Events:
//   progress : { step: string }
//   thinking : { text: string }      (live reasoning trace)
//   text     : { text: string }      (main answer stream, discarded — we use final only)
//   result   : { tree, explanation, perType, provider, model, meta }
//   error    : { error: string }
//   done     : {}
//
// Uses:
//   - Claude extended thinking (thinking: {type:"enabled"}, stream:true)
//   - Gemini thinkingConfig.includeThoughts with streamGenerateContent
// Reasoning is surfaced the same way it is in chat UIs.

import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import {
  allCategoriesBySize,
  categoryMembers,
  mwGet,
  parseFandomOrigin,
} from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Provider = "gemini" | "claude";

const MODELS: Record<Provider, string[]> = {
  gemini: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
  claude: ["claude-opus-4-7", "claude-sonnet-4-6"],
};
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-3.1-pro-preview",
  claude: "claude-sonnet-4-6",
};

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

  let origin = "";
  try {
    origin = rawOrigin.includes("/wiki/")
      ? parseFandomOrigin(rawOrigin)
      : new URL(rawOrigin).origin;
  } catch (e: any) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "bad origin" })}\n\n`,
      { headers: sseHeaders() }
    );
  }
  const model =
    requestedModel && MODELS[provider].includes(requestedModel)
      ? requestedModel
      : DEFAULT_MODEL[provider];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: any) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(enc.encode(payload));
      };
      try {
        send("progress", { step: "siteinfo" });
        const ctx = await gatherContext(origin, (step) =>
          send("progress", { step })
        );
        send("progress", {
          step: `context ready — nav ${ctx.navCount}, cats ${ctx.topCategories.length}, pages ${ctx.pageDetails.length}`,
        });
        send("progress", { step: `calling ${provider} · ${model}` });

        const finalText = await runLLMStream({
          provider,
          model,
          ctx,
          onThinking: (t) => send("thinking", { text: t }),
          onText: (t) => send("text", { text: t }),
        });

        const parsed = parseAnalyzeJson(finalText);
        send("result", {
          provider,
          model,
          origin,
          tree: parsed.tree,
          explanation: parsed.explanation,
          perType: parsed.perType,
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
        send("error", { error: String(e?.message || e) });
      } finally {
        controller.enqueue(
          new TextEncoder().encode(`event: done\ndata: {}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

// =========================================================================
// Context gathering (same as /analyze)
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

async function gatherContext(
  origin: string,
  onStep: (s: string) => void
): Promise<Context> {
  onStep("fetching siteinfo + nav + categories");
  const [info, navData, categoriesRaw] = await Promise.all([
    siteInfoPlus(origin),
    fetchNav(origin),
    allCategoriesBySize(origin, { maxCategories: 4000, minPages: 3 }).catch(
      () => []
    ),
  ]);

  onStep("fetching main page lead");
  const mainpageLead = await fetchMainPageLead(origin, info.mainpage);

  const topCategories = categoriesRaw
    .slice(0, TOP_CATEGORIES)
    .map((c) => ({ name: c.name, pages: c.pages, subcats: c.subcats }));
  const canonSignalCategories = categoriesRaw
    .filter((c) =>
      /canon|legends|non[- ]?canon|retcon|continuity|timeline|reboot|multiverse|alternate|era|age|chronolog|appendix|ambiguous|disputed/i.test(
        c.name
      )
    )
    .slice(0, 40)
    .map((c) => ({ name: c.name, pages: c.pages }));

  onStep(`sampling members of top ${SAMPLED_CATEGORIES} categories`);
  const categoriesToSample = categoriesRaw.slice(0, SAMPLED_CATEGORIES);
  const categorySamples = await mapLimited(categoriesToSample, 4, async (c) => {
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
  });

  const pickedTitles = pickRoundRobin(
    categorySamples.map((s) => s.members),
    DETAILED_PAGES
  );
  onStep(`fingerprinting ${pickedTitles.length} pages`);
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

async function fetchNav(origin: string) {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: "MediaWiki:Wiki-navigation",
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  const wikitext: string = j?.parse?.wikitext || "";
  if (!wikitext) return { lines: [] as string[], count: 0 };
  const lines: string[] = [];
  for (const raw of wikitext.split(/\r?\n/)) {
    const m = raw.match(/^(\*+)\s*(.+)$/);
    if (!m) continue;
    const depth = m[1].length - 1;
    let label = m[2].trim().replace(/^\[\[|\]\]$/g, "");
    const pipe = label.indexOf("|");
    if (pipe >= 0) label = label.slice(pipe + 1).trim();
    if (!label) continue;
    lines.push("  ".repeat(depth) + label);
  }
  return { lines, count: lines.length };
}

async function fetchMainPageLead(origin: string, mainpage: string) {
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

function extractInfoboxFields(wikitext: string) {
  if (!wikitext) return { fields: [] as string[] };
  const startRe = /\{\{\s*([^|{}\n]*\binfobox\b[^|{}\n]*)/i;
  const startMatch = startRe.exec(wikitext);
  if (!startMatch) return { fields: [] as string[] };
  const name = startMatch[1].trim();
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
  const fields = splitTopLevelPipes(body)
    .slice(1)
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return null;
      const k = p.slice(0, eq).trim();
      if (!k || k.length > 40 || /[\n{}]/.test(k)) return null;
      return k;
    })
    .filter((k): k is string => !!k);
  return { template: name, fields: Array.from(new Set(fields)).slice(0, 40) };
}

function splitTopLevelPipes(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let link = 0;
  let tmpl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i],
      c2 = s[i + 1];
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
// LLM streaming (with thinking)
// =========================================================================

const SYSTEM = [
  "You are a media-franchise analyst studying a single Fandom wiki.",
  "Describe — do not prescribe — how THIS IP's community organizes its canon.",
  "",
  "Produce:",
  "1. A hierarchical tree of the canon's ORGANIZATION (tiers / continuities /",
  "   eras / media / factions — whatever the wiki actually uses).",
  "2. A prose META-EXPLANATION of the organizing logic: what signals the wiki",
  "   uses to classify a work as canon, how it handles reboots / alternate",
  "   continuities / retcons / expanded media / non-canon spinoffs.",
  "3. A PER-TYPE SCHEMA for each major item type found on the wiki",
  "   (Character, Location, Episode, Game, Faction, Weapon, Event, etc.)",
  "   with the infobox template, observed FIELDS (attributes), common section",
  "   headings, categorization axes, and 2–5 example titles.",
  "",
  "Ground every claim in the context block. Quote category names verbatim.",
  "Field names MUST be observed infobox keys. Do not propose reorganization.",
  "",
  "OUTPUT — STRICT JSON, nothing outside the JSON:",
  "{",
  '  "tree": CanonNode[],          // up to 5 levels, ~60 nodes',
  '  "explanation": string,        // markdown, 500–1200 words',
  '  "perType": TypeSchema[]       // 4–12 types',
  "}",
  "CanonNode  = { label: string, note?: string, children?: CanonNode[] }",
  "TypeSchema = { type, template?, fields[], commonSections[], categoryAxes[], examples[], notes? }",
].join("\n");

function userMsg(ctx: Context): string {
  const nav = ctx.navLines.slice(0, 200).join("\n") || "(no MediaWiki:Wiki-navigation)";
  const topCats =
    ctx.topCategories
      .map((c) => `- ${c.name} (${c.pages} pages, ${c.subcats} subcats)`)
      .join("\n") || "(none)";
  const canonSig = ctx.canonSignalCategories.length
    ? ctx.canonSignalCategories.map((c) => `- ${c.name} (${c.pages})`).join("\n")
    : "(none found — wiki may not use explicit canon-policy categories)";
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
    `=== DETAILED PAGE FINGERPRINTS (${ctx.pageDetails.length}) ===`,
    details,
    "",
    "Produce the JSON object.",
  ].join("\n");
}

type RunArgs = {
  provider: Provider;
  model: string;
  ctx: Context;
  onThinking: (s: string) => void;
  onText: (s: string) => void;
};

async function runLLMStream(a: RunArgs): Promise<string> {
  if (a.provider === "claude") return streamClaude(a);
  return streamGemini(a);
}

// ----- Claude extended thinking stream ----------------------------------
async function streamClaude(a: RunArgs): Promise<string> {
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
      model: a.model,
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 6000 },
      system: SYSTEM,
      stream: true,
      messages: [{ role: "user", content: userMsg(a.ctx) }],
    }),
  });
  if (!r.ok || !r.body)
    throw new Error(`Claude ${r.status}: ${await r.text()}`);

  let finalText = "";
  for await (const event of parseSSE(r.body)) {
    // Anthropic streams event_type: (event line) + JSON (data line).
    if (event.event !== "content_block_delta") continue;
    const d = event.data?.delta;
    if (!d) continue;
    if (d.type === "thinking_delta" && typeof d.thinking === "string") {
      a.onThinking(d.thinking);
    } else if (d.type === "text_delta" && typeof d.text === "string") {
      finalText += d.text;
      a.onText(d.text);
    }
  }
  return finalText;
}

// ----- Gemini thinking stream -------------------------------------------
async function streamGemini(a: RunArgs): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(a.model)}:streamGenerateContent?alt=sse&key=${key}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: userMsg(a.ctx) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.25,
        maxOutputTokens: 16000,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: -1, // dynamic
        },
      },
    }),
  });
  if (!r.ok || !r.body)
    throw new Error(`Gemini ${r.status}: ${await r.text()}`);

  let finalText = "";
  for await (const event of parseSSE(r.body)) {
    // Gemini streams plain data-only SSE lines: `data: {...}`.
    const parts = event.data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (typeof p?.text !== "string") continue;
      if (p.thought === true) {
        a.onThinking(p.text);
      } else {
        finalText += p.text;
        a.onText(p.text);
      }
    }
  }
  return finalText;
}

// ----- Generic SSE parser ------------------------------------------------
type SSEEvent = { event: string; data: any };

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEChunk(raw);
      if (ev) yield ev;
    }
  }
}

function parseSSEChunk(raw: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment/keepalive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const raw2 = dataLines.join("\n");
  if (raw2 === "[DONE]") return null;
  try {
    return { event, data: JSON.parse(raw2) };
  } catch {
    return { event, data: raw2 };
  }
}

// =========================================================================
// JSON finalization
// =========================================================================

function parseAnalyzeJson(txt: string) {
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

type CanonNode = { label: string; note?: string; children?: CanonNode[] };
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
type TypeSchema = {
  type: string;
  template?: string;
  fields: string[];
  commonSections: string[];
  categoryAxes: string[];
  examples: string[];
  notes?: string;
};
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
