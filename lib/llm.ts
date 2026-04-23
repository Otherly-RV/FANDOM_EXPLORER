// lib/llm.ts
// Unified LLM interface for NARRATIVE extraction only.
// Never used for structural data (links/categories/sections) — those come
// straight from MediaWiki. The LLM only rewrites/condenses text that is
// already present in the real wiki page, so it cannot invent structure.

export type LLMProvider = "claude" | "gemini" | "none";

export type LLMBrief = {
  summary: string;       // 2–3 sentence overview grounded in the source paragraph
  keyFacts: string[];    // short bullets, each grounded in the source
  provider: LLMProvider;
  model?: string;
};

const SYSTEM = [
  "You condense Fandom wiki prose into a short reader-friendly brief.",
  "HARD RULES:",
  "- Use ONLY facts present in the provided text. Do not invent.",
  "- Do not output links, categories, or section names.",
  "- Return STRICT JSON: {\"summary\": string, \"keyFacts\": string[]}.",
  "- summary = 2-3 sentences, plain prose.",
  "- keyFacts = up to 5 short bullets, each <= 20 words.",
].join("\n");

function buildUserMsg(title: string, sourceText: string) {
  return `Wiki page: "${title}"\n\nSource text (verbatim from the page):\n---\n${sourceText.slice(0, 8000)}\n---\nReturn ONLY the JSON object.`;
}

function parseJson(txt: string): { summary: string; keyFacts: string[] } {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM returned no JSON");
  const o = JSON.parse(m[0]);
  return {
    summary: typeof o.summary === "string" ? o.summary : "",
    keyFacts: Array.isArray(o.keyFacts) ? o.keyFacts.filter((s: any) => typeof s === "string").slice(0, 5) : [],
  };
}

// ── Claude ────────────────────────────────────────────────────────────────
async function callClaude(title: string, sourceText: string): Promise<LLMBrief> {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("CLAUDE_API_KEY not set");
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserMsg(title, sourceText) }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const txt = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const parsed = parseJson(txt);
  return { ...parsed, provider: "claude", model };
}

// ── Gemini ────────────────────────────────────────────────────────────────
async function callGemini(title: string, sourceText: string): Promise<LLMBrief> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = process.env.GEMINI_MODEL || "gemini-3.1-pro";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: buildUserMsg(title, sourceText) }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 600 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const txt = (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("");
  const parsed = parseJson(txt);
  return { ...parsed, provider: "gemini", model };
}

// ── Dispatcher ────────────────────────────────────────────────────────────
export async function extractBrief(
  provider: LLMProvider,
  title: string,
  sourceText: string
): Promise<LLMBrief | null> {
  if (!sourceText || !sourceText.trim()) return null;
  try {
    if (provider === "claude") return await callClaude(title, sourceText);
    if (provider === "gemini") return await callGemini(title, sourceText);
    return null;
  } catch (e) {
    // Fail-soft: never break a crawl because the LLM hiccupped.
    console.warn("[llm]", provider, (e as Error).message);
    return null;
  }
}

export function availableProviders(): LLMProvider[] {
  const out: LLMProvider[] = ["none"];
  if (process.env.CLAUDE_API_KEY) out.push("claude");
  if (process.env.GEMINI_API_KEY) out.push("gemini");
  return out;
}
