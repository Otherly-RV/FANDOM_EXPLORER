// app/api/canon/inventory/route.ts
// Streams a REAL inventory of a Fandom wiki.
//
//   Types  = top categories that share a dominant infobox template.
//   Pages  = actual members of those categories (verbatim title + URL).
//   Fields = infobox key/value pairs parsed directly from wikitext (verbatim).
//
// The LLM is used ONLY to narrate meta-logic over this inventory.
// It never invents, renames, or rewrites any content. All text shown in the
// UI for pages / fields / values comes straight from MediaWiki.
//
// SSE events:
//   progress     { step }
//   meta         { sitename, mainpage, articles, totalCategories }
//   group_start  { gid, category, totalMembers }
//   group_type   { gid, template, matched, total }    (after classification)
//   page         { gid, title, url, template?, fields: [[key,value], ...] }
//   group_end    { gid }
//   thinking     { text }        (LLM reasoning, optional)
//   explanation  { text }        (final narrative markdown)
//   error        { error }
//   done         {}
//
// All content is literal wiki text. No paraphrase, no rewording.

import { NextRequest } from "next/server";
import {
  allCategoriesBySize,
  categoryMembers,
  mwGet,
  parseFandomOrigin,
  titleToUrl,
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

// Tunables — keep conservative; pages fetch is the bottleneck.
const TOP_CATEGORIES_TO_SCAN = 40;      // categories considered for grouping
const MAX_PAGES_PER_CATEGORY = 40;      // per-group page cap
const MIN_MEMBERS_FOR_GROUP = 4;        // skip tiny categories
const MIN_TEMPLATE_SHARE = 0.35;        // category counts as a "type" if this share of sampled pages share one infobox template
const GLOBAL_PAGE_BUDGET = 900;         // hard cap across all groups
const PAGE_CONCURRENCY = 6;
const GROUP_CONCURRENCY = 3;

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const rawOrigin: string = body.origin || body.url || "";
  const provider: Provider = body.provider === "claude" ? "claude" : "gemini";
  const requestedModel: string | undefined = body.model;

  let origin = "";
  try {
    origin = rawOrigin.includes("/wiki/")
      ? parseFandomOrigin(rawOrigin)
      : new URL(rawOrigin).origin;
  } catch {
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
      let closed = false;
      const send = (event: string, data: any) => {
        if (closed) return;
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      try {
        send("progress", { step: "siteinfo + categories" });
        const [info, catsRaw] = await Promise.all([
          siteInfoPlus(origin),
          allCategoriesBySize(origin, { maxCategories: 3000, minPages: 3 }).catch(() => []),
        ]);
        send("meta", {
          sitename: info.sitename || new URL(origin).hostname,
          mainpage: info.mainpage,
          articles: info.articles,
          totalCategories: catsRaw.length,
        });

        // Filter to plausible type-categories: exclude admin/maintenance.
        const candidate = catsRaw
          .filter((c) => !isAdminCategory(c.name))
          .filter((c) => c.pages >= MIN_MEMBERS_FOR_GROUP)
          .slice(0, TOP_CATEGORIES_TO_SCAN);

        send("progress", {
          step: `scanning top ${candidate.length} categories (budget ${GLOBAL_PAGE_BUDGET} pages)`,
        });

        // Track what we've emitted for the LLM context.
        const inventoryForLLM: InventoryForLLM = { groups: [] };
        let budget = GLOBAL_PAGE_BUDGET;

        // Process groups with bounded concurrency, but emit events sequentially
        // (JS ReadableStream controllers are single-producer-safe).
        let gidCounter = 0;
        await runPool(candidate, GROUP_CONCURRENCY, async (c) => {
          if (budget <= 0) return;
          const gid = ++gidCounter;

          // Fetch members (pages only).
          let members: { title: string }[] = [];
          try {
            const mem = await categoryMembers(
              origin,
              c.name,
              "page",
              MAX_PAGES_PER_CATEGORY
            );
            members = mem.filter((m) => m.ns === 0).map((m) => ({ title: m.title }));
          } catch {
            return;
          }
          if (members.length < MIN_MEMBERS_FOR_GROUP) return;

          // Take up to the remaining budget for this group.
          const take = Math.min(members.length, budget);
          if (take <= 0) return;
          budget -= take;
          const slice = members.slice(0, take);

          send("group_start", {
            gid,
            category: c.name,
            totalMembers: c.pages,
            sampled: slice.length,
          });

          // Fetch wikitext for each, extract infobox template + fields.
          const detailed = await runPoolMap(
            slice,
            PAGE_CONCURRENCY,
            async (m) => {
              try {
                return await fetchPageInfobox(origin, m.title);
              } catch {
                return null;
              }
            }
          );

          // Determine dominant template.
          const tplCounts = new Map<string, number>();
          for (const d of detailed) {
            if (d?.template) {
              const key = d.template.toLowerCase();
              tplCounts.set(key, (tplCounts.get(key) || 0) + 1);
            }
          }
          let dominant: string | undefined;
          let dominantCount = 0;
          for (const [k, v] of tplCounts) {
            if (v > dominantCount) { dominant = k; dominantCount = v; }
          }
          const share = detailed.length ? dominantCount / detailed.length : 0;

          // A group becomes a "type" if enough pages share an infobox template.
          const isType = !!dominant && share >= MIN_TEMPLATE_SHARE;

          send("group_type", {
            gid,
            template: isType ? dominant : undefined,
            matched: dominantCount,
            total: detailed.length,
            share: Math.round(share * 100),
            isType,
          });

          // Emit each page (verbatim).
          const llmPages: { title: string; fieldKeys: string[] }[] = [];
          for (let i = 0; i < slice.length; i++) {
            const m = slice[i];
            const d = detailed[i];
            const payload = {
              gid,
              title: m.title,
              url: titleToUrl(origin, m.title),
              template: d?.template,
              fields: d?.fields || [], // [[key,value], ...] verbatim
            };
            send("page", payload);
            if (d?.fields?.length) {
              llmPages.push({ title: m.title, fieldKeys: d.fields.map(([k]) => k) });
            }
          }

          send("group_end", { gid });

          // Stash for LLM (keys only, no values — we don't want the model
          // to ingest or reshape the actual content).
          inventoryForLLM.groups.push({
            category: c.name,
            template: isType ? dominant : undefined,
            sampled: slice.length,
            total: c.pages,
            isType,
            pages: llmPages.slice(0, 20),
          });
        });

        // ----- LLM narrative (META ONLY, no content rewriting) -----
        send("progress", { step: `calling ${provider} · ${model} for meta explanation` });

        try {
          const narrative = await runLLM({
            provider,
            model,
            site: {
              sitename: info.sitename || new URL(origin).hostname,
              origin,
              articles: info.articles,
            },
            inventory: inventoryForLLM,
            onThinking: (t) => send("thinking", { text: t }),
          });
          send("explanation", { text: narrative });
        } catch (e: any) {
          send("explanation", {
            text: `_Meta explanation failed: ${escape(String(e?.message || e))}_`,
          });
        }
      } catch (e: any) {
        send("error", { error: String(e?.message || e) });
      } finally {
        try {
          controller.enqueue(
            new TextEncoder().encode(`event: done\ndata: {}\n\n`)
          );
        } catch { /* */ }
        closed = true;
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

// ===========================================================================
// MediaWiki helpers
// ===========================================================================

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
      articles: Number(s.articles) || 0,
    };
  } catch {
    return { mainpage: "Main Page", sitename: "", articles: 0 };
  }
}

type PageInfobox = {
  template?: string;
  fields: [string, string][]; // [key, value] VERBATIM from wikitext (lightly cleaned)
};

async function fetchPageInfobox(origin: string, title: string): Promise<PageInfobox | null> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: title,
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  if (!j?.parse) return null;
  const wikitext: string = j.parse.wikitext?.["*"] || j.parse.wikitext || "";
  return extractInfobox(wikitext);
}

function extractInfobox(wikitext: string): PageInfobox {
  if (!wikitext) return { fields: [] };
  const startRe = /\{\{\s*([^|{}\n]*\binfobox\b[^|{}\n]*)/i;
  const startMatch = startRe.exec(wikitext);
  if (!startMatch) return { fields: [] };
  const template = startMatch[1].trim();

  // Find matching closing }} with brace counting.
  let i = startMatch.index;
  let depth = 0;
  let end = -1;
  for (; i < wikitext.length; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") { depth++; i++; }
    else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
      depth--; i++;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return { template, fields: [] };

  const body = wikitext.slice(startMatch.index, end);
  const parts = splitTopLevelPipes(body).slice(1); // drop template name
  const fields: [string, string][] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (!k || k.length > 40 || /[\n{}]/.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    const v = cleanValue(p.slice(eq + 1));
    fields.push([k, v]);
    if (fields.length >= 60) break;
  }
  return { template, fields };
}

function splitTopLevelPipes(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let link = 0, tmpl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (c === "[" && c2 === "[") { link++; buf += "[["; i++; continue; }
    if (c === "]" && c2 === "]") { link--; buf += "]]"; i++; continue; }
    if (c === "{" && c2 === "{") { tmpl++; buf += "{{"; i++; continue; }
    if (c === "}" && c2 === "}") { tmpl--; buf += "}}"; i++; continue; }
    if (c === "|" && link === 0 && tmpl === 1) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

// Minimal cleanup so values are readable in the UI but still literal:
//   - [[Target|Label]]  -> Label
//   - [[Target]]        -> Target
//   - strip <ref>...</ref> and <!--...-->
//   - strip surrounding {{nowrap|X}} -> X (one level)
//   - collapse whitespace; cap length
function cleanValue(raw: string): string {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<ref[^>]*\/\s*>/gi, "");
  // Pipe-links first.
  s = s.replace(/\[\[([^\]\|]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  // Strip one level of simple {{X|...}} wrappers keeping last positional arg.
  s = s.replace(/\{\{[^{}]*\}\}/g, (m) => {
    const inner = m.slice(2, -2);
    const bits = inner.split("|");
    return bits.length > 1 ? bits[bits.length - 1] : "";
  });
  // HTML tags -> text.
  s = s.replace(/<br\s*\/?>/gi, " · ");
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 400) s = s.slice(0, 400) + "…";
  return s;
}

function isAdminCategory(name: string): boolean {
  return /^(hidden|tracking|stub|stubs|article stubs|candidates for|pages|maintenance|wiki|wikia|community|admin|blog posts|files|images|videos|galleries|templates?|infobox templates?|disambig|redirects?|needs?|lists?|articles needing|articles with|all articles|browse|contents|help|policy|site|special|categories|pages? with|pages? using|tracking categories)\b/i.test(name);
}

// ===========================================================================
// Pool helpers
// ===========================================================================

async function runPool<T>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<void>
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      try { await fn(items[cur]); } catch { /* */ }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}

async function runPoolMap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      try { out[cur] = await fn(items[cur]); }
      catch { out[cur] = undefined as any; }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

// ===========================================================================
// LLM — META NARRATIVE ONLY. Does not see/alter page content.
// ===========================================================================

type InventoryForLLM = {
  groups: {
    category: string;
    template?: string;
    sampled: number;
    total: number;
    isType: boolean;
    pages: { title: string; fieldKeys: string[] }[]; // no values
  }[];
};

const SYSTEM = [
  "You are a media-franchise analyst.",
  "You are given a machine-built inventory of a Fandom wiki: the real",
  "categories, the dominant infobox template per category, sample page titles,",
  "and the set of infobox field KEYS observed (values are deliberately withheld).",
  "",
  "Your job: explain how THIS franchise organizes its canon and its items.",
  "Describe the observed structure. Do not invent categories, do not rename",
  "anything, do not propose reorganization. Quote category and template names",
  "verbatim. Keep it grounded: every claim must be traceable to the inventory.",
  "",
  "Output: markdown, 400–900 words. Suggested sections:",
  "  ## Canon policy signals",
  "  ## Item types",
  "  ## Organizing axes",
  "  ## Notable gaps or ambiguities",
  "",
  "Do NOT restate the raw lists — summarize the LOGIC.",
].join("\n");

function buildUserMessage(site: { sitename: string; origin: string; articles: number }, inv: InventoryForLLM): string {
  const typeGroups = inv.groups.filter((g) => g.isType);
  const otherGroups = inv.groups.filter((g) => !g.isType);
  const typeBlock = typeGroups.map((g) => {
    const keys = new Map<string, number>();
    for (const p of g.pages) for (const k of p.fieldKeys) keys.set(k, (keys.get(k) || 0) + 1);
    const topKeys = [...keys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([k, n]) => `${k}(${n})`)
      .join(", ");
    const examples = g.pages.slice(0, 5).map((p) => p.title).join(" | ");
    return `- "${g.category}" — template: ${g.template || "(none)"} — sampled ${g.sampled}/${g.total}\n    field keys: ${topKeys}\n    examples: ${examples}`;
  }).join("\n");
  const otherBlock = otherGroups
    .slice(0, 30)
    .map((g) => `- "${g.category}" (${g.total} pages, no dominant infobox)`)
    .join("\n");
  return [
    `Wiki: ${site.sitename}`,
    `Origin: ${site.origin}`,
    `Articles: ${site.articles}`,
    "",
    `=== ITEM TYPES (categories with a dominant infobox) — ${typeGroups.length} ===`,
    typeBlock || "(none detected)",
    "",
    `=== OTHER MAJOR CATEGORIES (no single infobox template) ===`,
    otherBlock || "(none)",
    "",
    "Produce the markdown narrative now.",
  ].join("\n");
}

type RunArgs = {
  provider: Provider;
  model: string;
  site: { sitename: string; origin: string; articles: number };
  inventory: InventoryForLLM;
  onThinking: (t: string) => void;
};

async function runLLM(a: RunArgs): Promise<string> {
  if (a.provider === "claude") return streamClaude(a);
  return streamGemini(a);
}

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
      max_tokens: 8000,
      thinking: { type: "enabled", budget_tokens: 4000 },
      system: SYSTEM,
      stream: true,
      messages: [{ role: "user", content: buildUserMessage(a.site, a.inventory) }],
    }),
  });
  if (!r.ok || !r.body) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  let finalText = "";
  for await (const ev of parseSSE(r.body)) {
    if (ev.event !== "content_block_delta") continue;
    const d = ev.data?.delta;
    if (!d) continue;
    if (d.type === "thinking_delta" && typeof d.thinking === "string") a.onThinking(d.thinking);
    else if (d.type === "text_delta" && typeof d.text === "string") finalText += d.text;
  }
  return finalText;
}

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
      contents: [{ role: "user", parts: [{ text: buildUserMessage(a.site, a.inventory) }] }],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 8000,
        thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
      },
    }),
  });
  if (!r.ok || !r.body) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  let finalText = "";
  for await (const ev of parseSSE(r.body)) {
    const parts = ev.data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (typeof p?.text !== "string") continue;
      if (p.thought === true) a.onThinking(p.text);
      else finalText += p.text;
    }
  }
  return finalText;
}

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
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const raw2 = dataLines.join("\n");
  if (raw2 === "[DONE]") return null;
  try { return { event, data: JSON.parse(raw2) }; }
  catch { return { event, data: raw2 }; }
}

function escape(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}
