// app/api/canon/narrative/route.ts
//
// STAGE 3 — LLM meta narrative. Called once after all content is loaded
// on the client. Receives only category names, templates, titles,
// field KEYS and section HEADINGS (no values, no prose) — the model
// never sees the real content so it cannot paraphrase it.
//
// SSE events:
//   thinking    { text }            — delta chunk of thinking (append)
//   explanation { text, delta? }    — if delta=true, append; otherwise replace
//   error       { error }
//   done        {}

import { NextRequest } from "next/server";

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

type GroupSummary = {
  category: string;
  template?: string;
  total: number;
  sampled: number;
  isType: boolean;
  pages: { title: string; fieldKeys: string[]; sectionHeadings: string[] }[];
};

const SYSTEM = [
  "You are a media-franchise analyst.",
  "You are given a machine-built inventory of a Fandom wiki: the real",
  "categories, the dominant infobox template per category, sample page titles,",
  "and the set of infobox field KEYS and section HEADINGS observed",
  "(values and prose are deliberately withheld).",
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

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const provider: Provider = body.provider === "claude" ? "claude" : "gemini";
  const requestedModel: string | undefined = body.model;
  const model =
    requestedModel && MODELS[provider].includes(requestedModel)
      ? requestedModel
      : DEFAULT_MODEL[provider];
  const site = body.site || { sitename: "", origin: "", articles: 0 };
  const groups: GroupSummary[] = Array.isArray(body.groups) ? body.groups : [];

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
      let explanationChars = 0;
      const onThinking = (t: string) => send("thinking", { text: t });
      const onExplanationDelta = (t: string) => {
        if (!t) return;
        explanationChars += t.length;
        send("explanation", { text: t, delta: true });
      };
      const onExplanationFinal = (t: string) => {
        // Final safety net: if nothing was streamed but we have a full text,
        // send it as a non-delta replacement.
        if (explanationChars === 0 && t) send("explanation", { text: t, delta: false });
      };
      try {
        const user = buildUserMessage(site, groups);
        const runOnce = async (m: string) => {
          if (provider === "claude") {
            await streamClaude(m, user, onThinking, onExplanationDelta, onExplanationFinal);
          } else {
            await streamGemini(m, user, onThinking, onExplanationDelta, onExplanationFinal);
          }
        };
        try {
          await runOnce(model);
        } catch (primaryErr: any) {
          // Auto-fallback: if the preview / requested model fails (404, empty
          // response, or any error) try a stable fallback from the same
          // provider before giving up.
          const fallbacks = MODELS[provider].filter((m) => m !== model);
          const fb = fallbacks[0];
          if (fb && explanationChars === 0) {
            send("thinking", {
              text: `\n[falling back from ${model} to ${fb} after error: ${String(primaryErr?.message || primaryErr).slice(0, 200)}]\n`,
            });
            await runOnce(fb);
          } else {
            throw primaryErr;
          }
        }
        if (explanationChars === 0) {
          send("error", {
            error: "The model finished without producing any explanation text. " +
              `(provider=${provider}, model=${model})`,
          });
        }
      } catch (e: any) {
        send("error", { error: String(e?.message || e) });
      } finally {
        try { controller.enqueue(new TextEncoder().encode(`event: done\ndata: {}\n\n`)); } catch { /* */ }
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

function buildUserMessage(site: any, groups: GroupSummary[]): string {
  const typeGroups = groups.filter((g) => g.isType);
  const otherGroups = groups.filter((g) => !g.isType);
  const typeBlock = typeGroups.map((g) => {
    const keys = new Map<string, number>();
    const heads = new Map<string, number>();
    for (const p of g.pages) {
      for (const k of p.fieldKeys) keys.set(k, (keys.get(k) || 0) + 1);
      for (const h of p.sectionHeadings) heads.set(h, (heads.get(h) || 0) + 1);
    }
    const topKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k}(${n})`).join(", ");
    const topHeads = [...heads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([h, n]) => `${h}(${n})`).join(", ");
    const examples = g.pages.slice(0, 5).map((p) => p.title).join(" | ");
    return `- "${g.category}" — template: ${g.template || "(none)"} — ${g.sampled}/${g.total}\n    field keys: ${topKeys}\n    section headings: ${topHeads}\n    examples: ${examples}`;
  }).join("\n");
  const otherBlock = otherGroups.slice(0, 30).map((g) => `- "${g.category}" (${g.total} pages, no dominant infobox)`).join("\n");
  return [
    `Wiki: ${site.sitename}`,
    `Origin: ${site.origin}`,
    `Articles: ${site.articles}`,
    "",
    `=== ITEM TYPES — ${typeGroups.length} ===`,
    typeBlock || "(none detected)",
    "",
    `=== OTHER MAJOR CATEGORIES ===`,
    otherBlock || "(none)",
    "",
    "Produce the markdown narrative now.",
  ].join("\n");
}

async function streamClaude(
  model: string,
  user: string,
  onThinking: (t: string) => void,
  onExplanationDelta: (t: string) => void,
  onExplanationFinal: (t: string) => void
): Promise<void> {
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
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 4000 },
      system: SYSTEM,
      stream: true,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok || !r.body) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  let finalText = "";
  for await (const ev of parseSSE(r.body)) {
    if (ev.event !== "content_block_delta") continue;
    const d = ev.data?.delta;
    if (!d) continue;
    if (d.type === "thinking_delta" && typeof d.thinking === "string") onThinking(d.thinking);
    else if (d.type === "text_delta" && typeof d.text === "string") {
      finalText += d.text;
      onExplanationDelta(d.text);
    }
  }
  onExplanationFinal(finalText);
}

async function streamGemini(
  model: string,
  user: string,
  onThinking: (t: string) => void,
  onExplanationDelta: (t: string) => void,
  onExplanationFinal: (t: string) => void
): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.25,
        // NOTE: for Gemini 2.5/3 Pro, maxOutputTokens is the total budget
        // (thinking + visible). We cap thinking explicitly so the model
        // cannot spend the whole budget on thoughts and finish empty.
        maxOutputTokens: 24000,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 },
      },
    }),
  });
  if (!r.ok || !r.body) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  let finalText = "";
  let finishReason = "";
  let usage: any = null;
  let promptFeedback: any = null;
  for await (const ev of parseSSE(r.body)) {
    const cand = ev.data?.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    if (ev.data?.usageMetadata) usage = ev.data.usageMetadata;
    if (ev.data?.promptFeedback) promptFeedback = ev.data.promptFeedback;
    const parts = cand?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (typeof p?.text !== "string") continue;
      if (p.thought === true) onThinking(p.text);
      else {
        finalText += p.text;
        onExplanationDelta(p.text);
      }
    }
  }
  if (!finalText) {
    const details = [
      finishReason ? `finishReason=${finishReason}` : "",
      usage ? `usage=${JSON.stringify(usage)}` : "",
      promptFeedback ? `promptFeedback=${JSON.stringify(promptFeedback)}` : "",
    ].filter(Boolean).join(" · ");
    throw new Error(`Gemini produced no visible text${details ? ` (${details})` : ""}`);
  }
  onExplanationFinal(finalText);
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
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const raw2 = dataLines.join("\n");
      if (raw2 === "[DONE]") continue;
      try { yield { event, data: JSON.parse(raw2) }; }
      catch { yield { event, data: raw2 }; }
    }
  }
}
