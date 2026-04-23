"use client";
// app/canon-panel.tsx
// Canon Logic view — REAL inventory, not LLM-invented schema.
// Layout: 2/3 inventory (left) · 1/3 meta explanation (right).
//
// Every page title, URL, infobox template name, field key and field VALUE
// shown here comes straight from MediaWiki's wikitext. The LLM only narrates
// the meta-logic on the right pane. It never rewrites wiki content.
//
// Orchestrated client-side in 3 stages:
//   1. /api/canon/inventory   — titles only (fast)
//   2. /api/canon/pages       — chunked content (client loops, bypasses Vercel timeout)
//   3. /api/canon/narrative   — LLM meta explanation

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// Context so inner components can resolve wiki: links -> in-doc anchors / external URLs
type LinkCtx = { origin: string; titleIndex: Map<string, string> };
const LinkContext = createContext<LinkCtx>({ origin: "", titleIndex: new Map() });
function useLinks() { return useContext(LinkContext); }

function slugify(s: string): string {
  return "page-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

type Provider = "gemini" | "claude";

type FieldPair = [string, string];

type Section = { heading: string; level: number; text: string };

type PageRow = {
  gid: number;
  title: string;
  url: string;
  template?: string;
  fields: FieldPair[];
  lead: string;
  sections: Section[];
};

type Group = {
  gid: number;
  category: string;
  totalMembers: number;
  sampled: number;
  template?: string;
  matched?: number;
  total?: number;
  share?: number;
  isType?: boolean;
  done?: boolean;
  pages: PageRow[];
  allTitles: string[];    // every title from the inventory (unchunked)
  fetched: number;        // how many have been loaded so far
};

type Meta = {
  sitename: string;
  mainpage: string;
  articles: number;
  totalCategories: number;
};

const MODEL_OPTIONS: { id: string; provider: Provider; label: string }[] = [
  { id: "gemini-3.1-pro-preview", provider: "gemini", label: "Gemini 3.1 Pro Preview (default)" },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", provider: "claude", label: "Claude Opus 4.7" },
];

function deriveOrigin(input: string): string {
  try { return new URL(input).origin; } catch { return ""; }
}

export default function CanonPanel({
  urlIn,
  onSeedCrawl,
}: {
  urlIn: string;
  onSeedCrawl?: (pages: { url: string; title: string }[]) => void;
}) {
  const origin = deriveOrigin(urlIn);
  const [modelId, setModelId] = useState<string>("gemini-3.1-pro-preview");
  const [pageBudget, setPageBudget] = useState<string>("300"); // "unlimited" or number string
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [explanation, setExplanation] = useState<string>("");
  const [thinking, setThinking] = useState<string>("");
  const [showThinking, setShowThinking] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [snapshots, setSnapshots] = useState<Array<{ id: string; name: string; origin: string; sitename?: string; articles?: number; created_at: string; group_count: number }>>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Use a ref mirror for mutating groups during stream to avoid stale state.
  const groupsRef = useRef<Group[]>([]);

  const upsertGroup = useCallback((updater: (prev: Group[]) => Group[]) => {
    groupsRef.current = updater(groupsRef.current);
    setGroups(groupsRef.current.slice());
  }, []);

  // Map page title -> slug anchor so wiki: links can resolve to in-doc anchors.
  const titleIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) {
      for (const p of g.pages) {
        if (!m.has(p.title)) m.set(p.title, slugify(p.title));
      }
    }
    return m;
  }, [groups]);

  // ---------- Snapshot list (persistent) ----------
  const refreshSnapshots = useCallback(async () => {
    try {
      const r = await fetch("/api/canon/snapshots");
      if (!r.ok) return;
      const rows = await r.json();
      if (Array.isArray(rows)) setSnapshots(rows);
    } catch { /* */ }
  }, []);
  useEffect(() => { refreshSnapshots(); }, [refreshSnapshots]);

  // ---------- Auto-cache last scan per origin in localStorage ----------
  useEffect(() => {
    if (!origin) return;
    const key = `canon:${origin}`;
    try {
      const cached = localStorage.getItem(key);
      if (cached && !groups.length && !loading) {
        const d = JSON.parse(cached);
        if (d?.groups?.length) {
          groupsRef.current = d.groups;
          setGroups(d.groups);
          setMeta(d.meta || null);
          setExplanation(d.explanation || "");
        }
      }
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);
  useEffect(() => {
    if (!origin || !groups.length) return;
    const key = `canon:${origin}`;
    try {
      localStorage.setItem(key, JSON.stringify({ meta, groups, explanation }));
    } catch { /* localStorage quota */ }
  }, [origin, groups, meta, explanation]);

  const save = useCallback(async () => {
    if (!origin || !groups.length) return;
    setSaveState("saving");
    try {
      const r = await fetch("/api/canon/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${meta?.sitename || origin} — ${new Date().toLocaleString()}`,
          origin,
          sitename: meta?.sitename,
          articles: meta?.articles,
          groups,
          explanation,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaveState("saved");
      refreshSnapshots();
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  }, [origin, groups, meta, explanation, refreshSnapshots]);

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/canon/snapshots/${id}`);
      if (!r.ok) return;
      const d = await r.json();
      const gs: Group[] = (d.groups || []).map((g: any) => ({
        gid: g.gid,
        category: g.category,
        totalMembers: g.totalMembers || g.total || 0,
        sampled: g.sampled || (g.pages ? g.pages.length : 0),
        template: g.template,
        matched: g.matched,
        total: g.total,
        share: g.share,
        isType: g.isType,
        done: true,
        allTitles: g.allTitles || (g.pages || []).map((p: any) => p.title),
        fetched: (g.pages || []).length,
        pages: g.pages || [],
      }));
      groupsRef.current = gs;
      setGroups(gs);
      setMeta({
        sitename: d.sitename || "",
        mainpage: "Main Page",
        articles: d.articles || 0,
        totalCategories: gs.length,
      });
      setExplanation(d.explanation || "");
      setError("");
      setProgress([`loaded snapshot ${d.name}`]);
    } catch (e: any) {
      setError(e?.message || "load failed");
    }
  }, []);

  const run = useCallback(async () => {
    if (!origin) return;
    setLoading(true);
    setError("");
    setMeta(null);
    setProgress([]);
    setThinking("");
    setExplanation("");
    groupsRef.current = [];
    setGroups([]);
    const opt = MODEL_OPTIONS.find((m) => m.id === modelId)!;
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      // ---------- STAGE 1: inventory (titles only) ----------
      const r = await fetch("/api/canon/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin,
          pageBudget: pageBudget === "unlimited" ? 0 : Number(pageBudget),
          perCategory: pageBudget === "unlimited" ? 0 : undefined,
        }),
        signal: ctl.signal,
      });
      if (!r.ok || !r.body) {
        const t = await r.text();
        throw new Error(`inventory HTTP ${r.status}: ${t.slice(0, 400)}`);
      }
      const reader = r.body.getReader();
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
          const ev = parseSSE(raw);
          if (!ev) continue;
          if (ev.event === "progress") {
            setProgress((p) => [...p, String(ev.data?.step || "")]);
          } else if (ev.event === "meta") {
            setMeta(ev.data as Meta);
          } else if (ev.event === "group") {
            const { gid, category, totalMembers, titles } = ev.data;
            const cap = pageBudget === "unlimited" ? titles.length : Math.min(titles.length, Number(pageBudget) || titles.length);
            const allTitles: string[] = titles.slice(0, cap);
            const g: Group = {
              gid,
              category,
              totalMembers,
              sampled: allTitles.length,
              pages: [],
              allTitles,
              fetched: 0,
            };
            upsertGroup((prev) => [...prev, g]);
          } else if (ev.event === "error") {
            setError(String(ev.data?.error || "inventory error"));
          }
        }
      }

      if (ctl.signal.aborted) return;
      const invGroups = groupsRef.current.slice();
      const totalTitles = invGroups.reduce((n, g) => n + g.allTitles.length, 0);
      setProgress((p) => [...p, `inventory done · ${invGroups.length} categories · ${totalTitles} pages to load`]);

      // ---------- STAGE 2: fetch page content in chunks ----------
      // Use a single shared queue across all groups so concurrency is global
      // and progress feels smooth. Each request asks for 20 titles.
      const BATCH = 20;
      const PARALLEL_REQUESTS = 3; // concurrent chunk requests

      type Task = { gid: number; titles: string[] };
      const queue: Task[] = [];
      for (const g of invGroups) {
        for (let i = 0; i < g.allTitles.length; i += BATCH) {
          queue.push({ gid: g.gid, titles: g.allTitles.slice(i, i + BATCH) });
        }
      }
      let totalFetched = 0;
      let qi = 0;
      async function worker() {
        while (qi < queue.length) {
          if (ctl.signal.aborted) return;
          const cur = qi++;
          const task = queue[cur];
          try {
            const resp = await fetch("/api/canon/pages", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ origin, titles: task.titles }),
              signal: ctl.signal,
            });
            if (!resp.ok) continue;
            const js = await resp.json();
            const pages: any[] = js.pages || [];
            upsertGroup((prev) => prev.map((g) => {
              if (g.gid !== task.gid) return g;
              const merged = pages.map((p) => ({
                gid: task.gid,
                title: p.title,
                url: p.url,
                template: p.template,
                fields: p.fields || [],
                lead: p.lead || "",
                sections: p.sections || [],
              }));
              return {
                ...g,
                pages: [...g.pages, ...merged],
                fetched: g.fetched + merged.length,
              };
            }));
            totalFetched += pages.length;
            setProgress((p) => {
              const last = p[p.length - 1];
              const msg = `fetching content… ${totalFetched}/${totalTitles}`;
              if (last && last.startsWith("fetching content…")) return [...p.slice(0, -1), msg];
              return [...p, msg];
            });
          } catch (e: any) {
            if (e?.name === "AbortError") return;
          }
        }
      }
      await Promise.all(Array.from({ length: PARALLEL_REQUESTS }, () => worker()));

      if (ctl.signal.aborted) return;

      // ---------- STAGE 2b: classify groups (dominant infobox) ----------
      upsertGroup((prev) => prev.map((g) => {
        const counts = new Map<string, number>();
        for (const p of g.pages) {
          if (p.template) {
            const k = p.template.toLowerCase();
            counts.set(k, (counts.get(k) || 0) + 1);
          }
        }
        let dominant: string | undefined;
        let dominantCount = 0;
        for (const [k, v] of counts) {
          if (v > dominantCount) { dominant = k; dominantCount = v; }
        }
        const share = g.pages.length ? dominantCount / g.pages.length : 0;
        const isType = !!dominant && share >= 0.35;
        return {
          ...g,
          template: isType ? dominant : undefined,
          matched: dominantCount,
          total: g.pages.length,
          share: Math.round(share * 100),
          isType,
          done: true,
        };
      }));

      // ---------- STAGE 3: meta narrative ----------
      await runNarrative(opt, ctl.signal);
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [origin, modelId, pageBudget, meta, upsertGroup]);

  // Run Stage 3 only — usable after load-snapshot, or after a narrative failure.
  const runNarrative = useCallback(async (opt?: typeof MODEL_OPTIONS[number], signal?: AbortSignal): Promise<void> => {
    const o = opt || MODEL_OPTIONS.find((m) => m.id === modelId)!;
    if (!groupsRef.current.length) { setError("No inventory to narrate. Scan first."); return; }
    setError("");
    setThinking("");
    setExplanation("");
    setProgress((p) => [...p, `calling ${o.provider} · ${o.id} for meta explanation`]);
    const llmGroups = groupsRef.current.map((g) => ({
      category: g.category,
      template: g.template,
      total: g.totalMembers,
      sampled: g.pages.length,
      isType: g.isType === true,
      pages: g.pages.slice(0, 20).map((p) => ({
        title: p.title,
        fieldKeys: p.fields.map(([k]) => k),
        sectionHeadings: p.sections.map((s) => s.heading),
      })),
    }));
    const narr = await fetch("/api/canon/narrative", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: o.provider,
        model: o.id,
        site: {
          sitename: meta?.sitename || origin,
          origin,
          articles: meta?.articles || 0,
        },
        groups: llmGroups,
      }),
      signal,
    });
    if (!narr.ok || !narr.body) {
      const t = await narr.text().catch(() => "");
      throw new Error(`narrative HTTP ${narr.status}: ${t.slice(0, 200)}`);
    }
    const nReader = narr.body.getReader();
    const dec = new TextDecoder();
    let nBuf = "";
    while (true) {
      const { value, done } = await nReader.read();
      if (done) break;
      nBuf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = nBuf.indexOf("\n\n")) >= 0) {
        const raw = nBuf.slice(0, idx);
        nBuf = nBuf.slice(idx + 2);
        const ev = parseSSE(raw);
        if (!ev) continue;
        if (ev.event === "thinking") setThinking((t) => t + String(ev.data?.text || ""));
        else if (ev.event === "explanation") setExplanation(String(ev.data?.text || ""));
        else if (ev.event === "error") setError(String(ev.data?.error || "narrative error"));
      }
    }
  }, [origin, modelId, meta]);

  const regenerateMeta = useCallback(async () => {
    setLoading(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      await runNarrative(undefined, ctl.signal);
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "narrative failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [runNarrative]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  if (!origin) {
    return <div style={{ padding: 16, color: "#888" }}>Enter a Fandom URL in the top bar.</div>;
  }

  // Split groups: types first (have dominant infobox), then others.
  const typeGroups = groups.filter((g) => g.isType);
  const otherGroups = groups.filter((g) => g.isType === false);
  const pendingGroups = groups.filter((g) => g.isType === undefined);
  const totalPages = groups.reduce((n, g) => n + g.pages.length, 0);

  return (
    <LinkContext.Provider value={{ origin, titleIndex }}>
    <div
      style={{
        display: "grid",
        // 2/3 · 1/3
        gridTemplateColumns: "2fr 1fr",
        height: "100%",
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* LEFT — inventory (2/3) */}
      <div style={{ borderRight: "1px solid #eceef4", overflowY: "auto", padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#2a2a3f" }}>
            Canon inventory
          </div>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="tbtn"
            style={{ appearance: "auto", fontSize: 11 }}
            disabled={loading}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select
            value={pageBudget}
            onChange={(e) => setPageBudget(e.target.value)}
            className="tbtn"
            style={{ appearance: "auto", fontSize: 11 }}
            disabled={loading}
            title="How many pages to fetch across the whole wiki"
          >
            <option value="100">100 pages</option>
            <option value="300">300 pages</option>
            <option value="600">600 pages</option>
            <option value="1500">1,500 pages</option>
            <option value="5000">5,000 pages</option>
            <option value="unlimited">All pages (slow)</option>
          </select>
          {!loading ? (
            <button className="tbtn primary" onClick={run}>
              {groups.length ? "Re-scan" : "Scan wiki"}
            </button>
          ) : (
            <button className="tbtn" onClick={stop}>Stop</button>
          )}
          {groups.length > 0 && !loading && (
            <>
              <button className="tbtn" onClick={() => downloadHtml(groups, explanation, meta, origin, titleIndex)}
                title="Download styled HTML — upload to Google Docs">⬇ HTML</button>
              <button className="tbtn" onClick={() => downloadGoogleDoc(groups, explanation, meta, origin, titleIndex)}
                title="Download a .doc Word-compatible file Google Docs opens natively">⬇ Google Doc</button>
              <button className="tbtn" onClick={() => downloadMarkdown(groups, explanation, meta, origin, titleIndex)}
                title="Download as Markdown">⬇ Markdown</button>
              <button
                className="tbtn primary"
                onClick={save}
                disabled={saveState === "saving"}
                title="Save this scan to the server"
              >
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : saveState === "error" ? "Save failed" : "💾 Save project"}
              </button>
              {onSeedCrawl && (
                <button
                  className="tbtn"
                  onClick={() => {
                    const pages = groups.flatMap((g) =>
                      g.pages.map((p) => ({ url: p.url, title: p.title }))
                    );
                    if (pages.length) onSeedCrawl(pages);
                  }}
                  title="Send every Canon page to the Crawl tab as its starting frontier"
                >🌱 Seed Crawl ({groups.reduce((n, g) => n + g.pages.length, 0).toLocaleString()})</button>
              )}
            </>
          )}
          {snapshots.length > 0 && (
            <select
              className="tbtn"
              style={{ appearance: "auto", fontSize: 11 }}
              value=""
              onChange={(e) => { if (e.target.value) loadSnapshot(e.target.value); }}
              disabled={loading}
              title="Load a saved scan"
            >
              <option value="">📂 Load project…</option>
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sitename || s.origin} — {new Date(s.created_at).toLocaleDateString()} ({s.group_count} groups)
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <div style={{
            background: "#fbeee2", border: "1px solid #e07a38", color: "#a04a18",
            padding: "6px 10px", borderRadius: 6, marginBottom: 10, fontSize: 11, whiteSpace: "pre-wrap",
          }}>{error}</div>
        )}

        {meta && (
          <div className="tlabel" style={{ marginBottom: 8 }}>
            {meta.sitename} · {meta.articles.toLocaleString()} articles · {meta.totalCategories.toLocaleString()} categories
            {" · "}
            {groups.length ? <>scanning <b>{groups.length}</b> groups · <b>{totalPages}</b> pages loaded</> : null}
          </div>
        )}

        {!groups.length && !loading && !error && (
          <div className="tlabel">
            Scans the wiki, groups every page by its category, detects the
            dominant infobox template per group, and lists every member with
            its real infobox fields — all content taken verbatim from the wiki.
            The model is only used for the meta explanation on the right.
          </div>
        )}

        {loading && progress.length > 0 && (
          <div style={{
            background: "#f4f5f9", border: "1px solid #eceef4", borderRadius: 6,
            padding: "6px 10px", marginBottom: 8, fontSize: 11,
            fontFamily: "monospace", color: "#444",
            maxHeight: 80, overflowY: "auto",
          }}>
            {progress.map((p, i) => <div key={i}><span style={{ color: "#5c54e8" }}>›</span> {p}</div>)}
            <div style={{ color: "#888" }}>…</div>
          </div>
        )}

        {typeGroups.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Heading>Item types ({typeGroups.length})</Heading>
            {typeGroups.map((g) => <GroupBlock key={g.gid} g={g} />)}
          </div>
        )}

        {pendingGroups.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Heading>Classifying…</Heading>
            {pendingGroups.map((g) => <GroupBlock key={g.gid} g={g} />)}
          </div>
        )}

        {otherGroups.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Heading>Other categories ({otherGroups.length})</Heading>
            {otherGroups.map((g) => <GroupBlock key={g.gid} g={g} />)}
          </div>
        )}
      </div>

      {/* RIGHT — meta explanation (1/3) */}
      <div style={{ overflowY: "auto", padding: 16, background: "#fafbff" }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#2a2a3f", marginBottom: 8 }}>
          Meta explanation
        </div>
        <div className="tlabel" style={{ marginBottom: 8 }}>
          The model reads the inventory summary and explains the canon logic.
          It does not touch page content.
        </div>

        {thinking && (
          <div style={{ border: "1px solid #e5d6f7", borderRadius: 6, background: "#faf7ff", marginBottom: 10 }}>
            <div
              onClick={() => setShowThinking((v) => !v)}
              style={{
                cursor: "pointer", padding: "6px 10px", fontSize: 11,
                fontWeight: 700, color: "#7a4ad0", display: "flex",
                alignItems: "center", gap: 6,
                borderBottom: showThinking ? "1px solid #e5d6f7" : "none",
              }}
            >
              <span style={{ fontSize: 9 }}>{showThinking ? "▼" : "▶"}</span>
              🧠 Model thinking {loading && <span className="spin" style={{ marginLeft: 4 }} />}
              <span style={{ marginLeft: "auto", color: "#a085cc", fontWeight: 400 }}>
                {thinking.length.toLocaleString()} chars
              </span>
            </div>
            {showThinking && (
              <pre
                ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                style={{
                  margin: 0, padding: "8px 10px",
                  maxHeight: 240, overflowY: "auto",
                  fontSize: 11, fontFamily: "ui-monospace, Menlo, monospace",
                  color: "#4a3a6f", whiteSpace: "pre-wrap", wordBreak: "break-word",
                  background: "transparent",
                }}
              >{thinking}</pre>
            )}
          </div>
        )}

        {explanation
          ? <MarkdownBlock text={explanation} />
          : (
            <div>
              {error && (
                <div style={{
                  background: "#fff4f4", border: "1px solid #f5c2c2", borderRadius: 6,
                  padding: "8px 10px", marginBottom: 10, fontSize: 12, color: "#a13232",
                }}>
                  <strong>Error:</strong> {error}
                </div>
              )}
              <div className="tlabel" style={{ marginBottom: 10 }}>
                {loading
                  ? "Waiting for the inventory to finish…"
                  : groups.length
                    ? "Inventory ready — click below to generate the meta explanation."
                    : "Scan the wiki to generate the explanation."}
              </div>
              {groups.length > 0 && !loading && (
                <button className="tbtn primary" onClick={regenerateMeta}>
                  ⚡ Generate meta explanation
                </button>
              )}
            </div>
          )}
        {explanation && !loading && groups.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #eceef4" }}>
            <button className="tbtn" onClick={regenerateMeta} style={{ fontSize: 11 }}>
              🔄 Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
    </LinkContext.Provider>
  );
}

// ===========================================================================
// Inventory UI
// ===========================================================================

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: "#5c54e8", textTransform: "uppercase",
      letterSpacing: ".06em", marginBottom: 6, marginTop: 8,
    }}>{children}</div>
  );
}

function GroupBlock({ g }: { g: Group }) {
  const [open, setOpen] = useState<boolean>(g.isType === true); // types default open
  const isType = g.isType === true;
  const isOther = g.isType === false;
  return (
    <div style={{
      border: "1px solid #eceef4",
      borderRadius: 6,
      marginBottom: 8,
      background: isType ? "#fafbff" : "#fff",
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          borderBottom: open ? "1px solid #eceef4" : "none",
        }}
      >
        <span style={{ fontSize: 10, color: "#5c54e8", width: 10 }}>{open ? "▼" : "▶"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#2a2a3f" }}>
            {g.category}
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 1 }}>
            {g.pages.length}/{g.totalMembers} pages
            {g.template ? <> · template <code style={codeStyle}>{g.template}</code></> : null}
            {typeof g.share === "number" ? <> · {g.share}% share</> : null}
            {isOther ? <> · no dominant infobox</> : null}
            {!g.done && <span className="spin" style={{ marginLeft: 6 }} />}
          </div>
        </div>
      </div>
      {open && (
        <div>
          {g.pages.length === 0
            ? <div style={{ padding: "6px 10px", fontSize: 11, color: "#888" }}>…</div>
            : g.pages.map((p) => <PageRow key={p.title} p={p} />)}
        </div>
      )}
    </div>
  );
}

function PageRow({ p }: { p: PageRow }) {
  const [open, setOpen] = useState<boolean>(false);
  const hasFields = p.fields.length > 0;
  const hasLead = !!p.lead.trim();
  const hasSections = p.sections.length > 0;
  const expandable = hasFields || hasLead || hasSections;
  const anchor = slugify(p.title);

  // When a wiki: link points to this page, scroll it into view and expand.
  useEffect(() => {
    function handler(e: Event) {
      const ev = e as CustomEvent<{ title: string }>;
      if (ev.detail?.title === p.title) setOpen(true);
    }
    window.addEventListener("canon:reveal", handler as EventListener);
    return () => window.removeEventListener("canon:reveal", handler as EventListener);
  }, [p.title]);

  return (
    <div id={anchor} style={{ borderTop: "1px solid #f1f3fa", scrollMarginTop: 50 }}>
      <div
        onClick={() => expandable && setOpen((v) => !v)}
        style={{
          padding: "4px 12px 4px 24px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: expandable ? "pointer" : "default",
        }}
      >
        <span style={{ fontSize: 9, color: expandable ? "#5c54e8" : "#ccc", width: 10 }}>
          {expandable ? (open ? "▼" : "▶") : "·"}
        </span>
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 12, color: "#2a2a3f", fontWeight: 500, textDecoration: "none" }}
        >
          {p.title}
        </a>
        <span style={{ fontSize: 10, color: "#888" }}>
          {hasFields ? `${p.fields.length} fields` : "no infobox"}
          {hasSections ? ` · ${p.sections.length} sections` : ""}
        </span>
      </div>
      {open && expandable && (
        <div style={{ padding: "4px 12px 10px 36px" }}>
          {hasFields && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "minmax(120px, max-content) 1fr",
              gap: "2px 10px",
              marginBottom: 10,
            }}>
              {p.fields.map(([k, v], i) => (
                <FieldRow key={`${i}-${k}`} k={k} v={v} />
              ))}
            </div>
          )}
          {hasLead && (
            <div style={{
              fontSize: 12, color: "#2a2a3f",
              lineHeight: 1.5, marginBottom: 10, borderLeft: "2px solid #eceef4",
              paddingLeft: 8, whiteSpace: "pre-wrap",
            }}><LinkedText text={p.lead} /></div>
          )}
          {hasSections && p.sections.map((s, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 12, fontWeight: 700, color: "#5c54e8",
                marginBottom: 3,
                paddingLeft: (s.level - 2) * 10,
              }}>{s.heading}</div>
              <div style={{
                fontSize: 12, color: "#2a2a3f",
                lineHeight: 1.5, paddingLeft: (s.level - 2) * 10 + 4,
                borderLeft: "2px solid #eceef4", marginLeft: (s.level - 2) * 10,
                whiteSpace: "pre-wrap",
              }}><LinkedText text={s.text} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  background: "#f4f5f9", padding: "0 4px", borderRadius: 3,
  fontFamily: "monospace", fontSize: ".9em", color: "#5c54e8",
};

// Renders text with [label](url) markdown links preserved.
// wiki:Target links resolve to in-doc anchors when the target title is known,
// otherwise fall through to the origin's /wiki/Target URL.
function LinkedText({ text }: { text: string }) {
  const { origin, titleIndex } = useLinks();
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const label = m[1];
    const href = m[2];
    if (href.startsWith("wiki:")) {
      const target = href.slice(5).trim();
      const slug = titleIndex.get(target);
      if (slug) {
        parts.push(
          <a
            key={idx++}
            href={`#${slug}`}
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById(slug);
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
                window.dispatchEvent(new CustomEvent("canon:reveal", { detail: { title: target } }));
              }
            }}
            style={{ color: "#5c54e8", textDecoration: "none", borderBottom: "1px dotted #5c54e8" }}
            title={`Go to ${target}`}
          >{label}</a>
        );
      } else {
        const url = `${origin}/wiki/${encodeURIComponent(target.replace(/ /g, "_"))}`;
        parts.push(
          <a key={idx++} href={url} target="_blank" rel="noreferrer"
             style={{ color: "#2a2a3f", textDecoration: "none", borderBottom: "1px dotted #aaa" }}
             title={`External: ${target}`}>{label}</a>
        );
      }
    } else {
      parts.push(
        <a key={idx++} href={href} target="_blank" rel="noreferrer"
           style={{ color: "#2a2a3f", textDecoration: "underline" }}>{label}</a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div style={{ fontSize: 11, color: "#5c54e8", fontFamily: "monospace", paddingTop: 2 }}>{k}</div>
      <div style={{ fontSize: 11, color: "#2a2a3f", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {v ? <LinkedText text={v} /> : <span style={{ color: "#bbb" }}>(empty)</span>}
      </div>
    </>
  );
}

// ===========================================================================
// Markdown (lightweight, same as before)
// ===========================================================================

function MarkdownBlock({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div style={{ fontSize: 13, color: "#2a2a3f", lineHeight: 1.55 }}>
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}
function renderBlock(block: string, key: number): JSX.Element {
  const t = block.trim();
  if (!t) return <div key={key} />;
  const h = t.match(/^(#{1,4})\s+(.+)$/);
  if (h) {
    const level = h[1].length;
    const size = [17, 15, 14, 13][level - 1];
    return <div key={key} style={{ fontSize: size, fontWeight: 700, color: "#2a2a3f", margin: "14px 0 6px" }}>{renderInline(h[2])}</div>;
  }
  const lines = t.split(/\n/);
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return (
      <ul key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
        {lines.map((l, i) => <li key={i} style={{ margin: "2px 0" }}>{renderInline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
      </ul>
    );
  }
  return <p key={key} style={{ margin: "8px 0" }}>{renderInline(t)}</p>;
}
function renderInline(s: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok === "\n") parts.push(<br key={idx++} />);
    else if (tok.startsWith("**")) parts.push(<strong key={idx++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) parts.push(<em key={idx++}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("`")) parts.push(
      <code key={idx++} style={{ background: "#f4f5f9", padding: "1px 4px", borderRadius: 3, fontSize: "0.9em" }}>{tok.slice(1, -1)}</code>
    );
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

// ===========================================================================
// Export (Google-Docs-friendly)
// ===========================================================================

function filenameSafe(s: string): string {
  return s.replace(/[^a-z0-9\-_.]+/gi, "_").replace(/^_+|_+$/g, "");
}
function downloadBlob(name: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Resolve [label](wiki:Target) tokens to real URLs or in-doc anchors.
function resolveWiki(text: string, origin: string, titleIndex: Map<string, string>, mode: "anchor" | "url"): string {
  return text.replace(/\[([^\]]+)\]\(wiki:([^)]+)\)/g, (_m, label, target) => {
    const t = String(target).trim();
    const slug = titleIndex.get(t);
    if (slug && mode === "anchor") return `[${label}](#${slug})`;
    const url = `${origin}/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`;
    return `[${label}](${url})`;
  });
}

function downloadMarkdown(groups: Group[], explanation: string, meta: Meta | null, origin: string, titleIndex: Map<string, string>) {
  const title = meta?.sitename || origin;
  const parts: string[] = [];
  parts.push(`# Canon inventory — ${title}`);
  parts.push(`*Origin: ${origin}*`);
  if (meta) parts.push(`*${meta.articles} articles · ${meta.totalCategories} categories*`);
  parts.push("");
  parts.push(`## Meta explanation`);
  parts.push(explanation || "_(none)_");
  parts.push("");
  const types = groups.filter((g) => g.isType);
  const others = groups.filter((g) => g.isType === false);
  parts.push(`## Item types`);
  for (const g of types) parts.push(groupToMarkdown(g, origin, titleIndex));
  if (others.length) {
    parts.push(`## Other categories`);
    for (const g of others) parts.push(groupToMarkdown(g, origin, titleIndex));
  }
  downloadBlob(`canon-${filenameSafe(title)}.md`, "text/markdown;charset=utf-8", parts.join("\n"));
}

function groupToMarkdown(g: Group, origin: string, titleIndex: Map<string, string>): string {
  const lines: string[] = [];
  lines.push(`### ${g.category}${g.template ? ` — \`${g.template}\`` : ""} (${g.pages.length}/${g.totalMembers})`);
  for (const p of g.pages) {
    const anchor = slugify(p.title);
    lines.push(`#### <a id="${anchor}"></a>[${p.title}](${p.url})`);
    if (p.fields.length) {
      for (const [k, v] of p.fields) {
        lines.push(`- **${k}:** ${v ? resolveWiki(v, origin, titleIndex, "anchor") : "_(empty)_"}`);
      }
    }
    if (p.lead.trim()) {
      lines.push("");
      lines.push(resolveWiki(p.lead, origin, titleIndex, "anchor"));
    }
    for (const s of p.sections) {
      const prefix = "#".repeat(Math.min(Math.max(s.level + 2, 3), 6));
      lines.push("");
      lines.push(`${prefix} ${s.heading}`);
      lines.push(resolveWiki(s.text, origin, titleIndex, "anchor"));
    }
    lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

function downloadGoogleDoc(groups: Group[], explanation: string, meta: Meta | null, origin: string, titleIndex: Map<string, string>) {
  // .doc with application/msword MIME — MS Word opens natively, Google Docs imports cleanly.
  const html = buildHtml(groups, explanation, meta, origin, titleIndex);
  const title = meta?.sitename || origin;
  downloadBlob(`canon-${filenameSafe(title)}.doc`, "application/msword", html);
}

function downloadHtml(groups: Group[], explanation: string, meta: Meta | null, origin: string, titleIndex: Map<string, string>) {
  const html = buildHtml(groups, explanation, meta, origin, titleIndex);
  const title = meta?.sitename || origin;
  downloadBlob(`canon-${filenameSafe(title)}.html`, "text/html;charset=utf-8", html);
}

function buildHtml(groups: Group[], explanation: string, meta: Meta | null, origin: string, titleIndex: Map<string, string>) {
  const title = meta?.sitename || origin;
  const expl = markdownToHtml(explanation || "");
  const types = groups.filter((g) => g.isType);
  const others = groups.filter((g) => g.isType === false);

  const groupHtml = (g: Group) => {
    const pages = g.pages.map((p) => {
      const anchor = slugify(p.title);
      const fields = p.fields.length
        ? "<dl>" + p.fields.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${inline(resolveWiki(v || "", origin, titleIndex, "anchor"))}</dd>`).join("") + "</dl>"
        : "";
      const lead = p.lead.trim() ? `<p>${inline(resolveWiki(p.lead, origin, titleIndex, "anchor")).replace(/\n/g, "<br>")}</p>` : "";
      const sections = p.sections.map((s) => {
        const lvl = Math.min(Math.max(s.level + 1, 4), 6);
        return `<h${lvl}>${escHtml(s.heading)}</h${lvl}><p>${inline(resolveWiki(s.text, origin, titleIndex, "anchor")).replace(/\n/g, "<br>")}</p>`;
      }).join("");
      return `<article id="${anchor}"><h4><a href="${escHtml(p.url)}">${escHtml(p.title)}</a></h4>${fields}${lead}${sections}</article>`;
    }).join("");
    return `<section><h3>${escHtml(g.category)}${g.template ? ` <code>${escHtml(g.template)}</code>` : ""} <span class="count">(${g.pages.length}/${g.totalMembers})</span></h3>${pages}</section>`;
  };

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Canon inventory — ${escHtml(title)}</title>
<style>
  body { font: 14px/1.55 -apple-system, system-ui, Segoe UI, sans-serif; color:#222; max-width: 920px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin-bottom: 2px; }
  h2 { font-size: 20px; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 32px; }
  h3 { font-size: 16px; margin-top: 22px; }
  h4 { font-size: 14px; margin-top: 16px; margin-bottom: 4px; }
  h5 { font-size: 13px; color:#5c54e8; margin: 10px 0 2px; }
  h6 { font-size: 12px; color:#5c54e8; margin: 8px 0 2px; }
  .meta { color:#666; font-size: 12px; margin-bottom: 20px; }
  .count { color: #888; font-weight: 400; font-size: 12px; }
  code { background:#f4f5f9; padding:1px 4px; border-radius:3px; font-size:.9em; color:#5c54e8; }
  article { margin: 10px 0 18px; padding-left: 10px; border-left: 2px solid #eceef4; }
  article p { margin: 6px 0; }
  ul.pages { padding-left: 22px; }
  ul.pages > li { margin: 6px 0; }
  dl { margin: 4px 0 8px 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; font-size: 12px; }
  dt { color: #5c54e8; font-family: monospace; }
  dd { margin: 0; color: #2a2a3f; white-space: pre-wrap; word-break: break-word; }
</style></head><body>
<h1>Canon inventory — ${escHtml(title)}</h1>
<div class="meta">
  Origin: ${escHtml(origin)}<br>
  ${meta ? `${meta.articles} articles · ${meta.totalCategories} categories` : ""}
</div>
<h2>Meta explanation</h2>
${expl}
<h2>Item types</h2>
${types.map(groupHtml).join("\n")}
${others.length ? `<h2>Other categories</h2>\n${others.map(groupHtml).join("\n")}` : ""}
</body></html>`;

  return html;
}

function markdownToHtml(md: string): string {
  const blocks = md.split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return "";
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const level = Math.min(Math.max(h[1].length + 1, 2), 5);
      return `<h${level}>${inline(h[2])}</h${level}>`;
    }
    const lines = t.split(/\n/);
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
  }).filter(Boolean).join("\n");
}
function inline(s: string): string {
  // Extract [label](url) tokens first (before escaping), replace with placeholders,
  // escape the rest, then reinsert as real anchors.
  const links: { label: string; url: string }[] = [];
  const withPh = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const i = links.length;
    links.push({ label, url });
    return `\u0001${i}\u0002`;
  });
  let out = escHtml(withPh)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\u0001(\d+)\u0002/g, (_m, idx) => {
    const { label, url } = links[Number(idx)];
    const safeUrl = escHtml(url);
    const safeLabel = escHtml(label);
    return `<a href="${safeUrl}">${safeLabel}</a>`;
  });
  return out;
}

// ===========================================================================
// SSE parser (client)
// ===========================================================================

function parseSSE(raw: string): { event: string; data: any } | null {
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
  try { return { event, data: JSON.parse(raw2) }; }
  catch { return { event, data: raw2 }; }
}
