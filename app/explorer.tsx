"use client";
// app/explorer.tsx — UI client. Fetches real structure from /api/crawl,
// persists snapshots via /api/projects (Neon, server-side only).
import { useEffect, useRef, useState } from "react";
import ProfilerPanel from "./profiler-panel";
import CanonPanel from "./canon-panel";

type Section = { heading: string; level: number; anchor: string };
type LLMProvider = "claude" | "gemini" | "none";
type PageData = {
  url: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  sections: Section[];
  categories: string[];
  links: string[];
  infobox?: Record<string, string>;
  keyFacts?: string[];
  aiProvider?: LLMProvider;
  aiModel?: string;
};

type Node = {
  url: string;
  title: string;
  depth: number;
  parentUrl: string | null;
  data: PageData | null;
  loading: boolean;
  error: boolean;
  x: number; y: number; vx: number; vy: number;
};
type Edge = { src: string; dst: string };

const COLORS = ["#5c54e8", "#2bbfbf", "#e07a38", "#d9507a", "#a855f7", "#10b981"];
const RADII = [14, 10, 8, 7, 6, 5];
const col = (d: number) => COLORS[Math.min(d, COLORS.length - 1)];
const rad = (d: number) => RADII[Math.min(d, RADII.length - 1)];

function titleFromUrl(u: string) {
  try { return decodeURIComponent(new URL(u).pathname.split("/wiki/")[1] || u).replace(/_/g, " "); }
  catch { return u; }
}
function originOf(u: string) { try { return new URL(u).origin; } catch { return ""; } }
function urlFromTitle(origin: string, t: string) {
  return origin + "/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));
}
function cardId(url: string) {
  // safe id: hash-like but stable
  let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  return "card_" + (h >>> 0).toString(36);
}

export default function Explorer() {
  const [urlIn, setUrlIn] = useState("https://harrypotter.fandom.com/wiki/Harry_Potter");
  const [maxP, setMaxP] = useState(25);
  const [crawling, setCrawling] = useState(false);
  const [viewMode, setViewMode] = useState<"network" | "tree" | "canon" | "canon-analysis">("network");
  const [allExpanded, setAllExpanded] = useState(false);
  const [status, setStatus] = useState("Ready — enter a Fandom URL and click Crawl.");
  const [provider, setProvider] = useState<LLMProvider>("none");
  const [availProviders, setAvailProviders] = useState<LLMProvider[]>(["none"]);
  const [providerDefaults, setProviderDefaults] = useState<{ claude?: string; gemini?: string }>({});
  const [concurrency, setConcurrency] = useState(3);
  const [autosave, setAutosave] = useState(true);
  const projectIdRef = useRef<string | null>(null);
  const pendingSaveRef = useRef<{ pages: any[]; edges: Edge[] }>({ pages: [], edges: [] });

  useEffect(() => {
    fetch("/api/providers").then((r) => r.json()).then((j) => {
      setAvailProviders(j.providers || ["none"]);
      setProviderDefaults(j.defaults || {});
    }).catch(() => {});
  }, []);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const nodesRef = useRef<Record<string, Node>>({});
  const edgesRef = useRef<Edge[]>([]);
  const queueRef = useRef<{ url: string; depth: number; parentUrl: string | null }[]>([]);
  const visitedRef = useRef<Set<string>>(new Set());
  const crawlingRef = useRef(false);
  const selUrlRef = useRef<string | null>(null);
  const progressRef = useRef(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const camRef = useRef({ x: 0, y: 0, z: 1 });
  const dragRef = useRef({ on: false, sx: 0, sy: 0, cx: 0, cy: 0 });

  // ── force layout ──────────────────────────────────────────────
  function placeNode(n: Node) {
    if (n.depth === 0) { n.x = 0; n.y = 0; return; }
    const a = Math.random() * Math.PI * 2, r = 140 * n.depth + Math.random() * 80;
    n.x = r * Math.cos(a); n.y = r * Math.sin(a);
  }
  function runForce(iters: number) {
    const ns = Object.values(nodesRef.current);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = 2400 / (d * d), fx = f * dx / d, fy = f * dy / d;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
      edgesRef.current.forEach((e) => {
        const a = nodesRef.current[e.src], b = nodesRef.current[e.dst]; if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = 110 + a.depth * 20, f = (d - ideal) * 0.05;
        a.vx += f * dx / d; a.vy += f * dy / d; b.vx -= f * dx / d; b.vy -= f * dy / d;
      });
      ns.forEach((n) => {
        n.vx -= n.x * 0.006; n.vy -= n.y * 0.006;
        n.x += n.vx * 0.45; n.y += n.vy * 0.45;
        n.vx *= 0.65; n.vy *= 0.65;
      });
    }
  }

  // ── canvas draw ───────────────────────────────────────────────
  function w2s(wx: number, wy: number): [number, number] {
    const c = camRef.current, cv = canvasRef.current!;
    return [(wx + c.x) * c.z + cv.width / 2, (wy + c.y) * c.z + cv.height / 2];
  }
  function s2w(sx: number, sy: number): [number, number] {
    const c = camRef.current, cv = canvasRef.current!;
    return [(sx - cv.width / 2) / c.z - c.x, (sy - cv.height / 2) / c.z - c.y];
  }
  function redraw() {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    cv.width = wrap.clientWidth; cv.height = wrap.clientHeight;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const ns = Object.values(nodesRef.current);
    if (!ns.length) {
      ctx.fillStyle = "#c0c4d0"; ctx.font = "12px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Enter a Fandom URL and Crawl", cv.width / 2, cv.height / 2);
      return;
    }
    edgesRef.current.forEach((e) => {
      const a = nodesRef.current[e.src], b = nodesRef.current[e.dst]; if (!a || !b) return;
      const [ax, ay] = w2s(a.x, a.y), [bx, by] = w2s(b.x, b.y);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = "rgba(80,90,150,0.25)"; ctx.lineWidth = 1; ctx.stroke();
    });
    ns.forEach((n) => {
      const [sx, sy] = w2s(n.x, n.y), r = rad(n.depth) * camRef.current.z, c = col(n.depth);
      if (n.url === selUrlRef.current) {
        ctx.beginPath(); ctx.arc(sx, sy, r + 7, 0, Math.PI * 2); ctx.fillStyle = c + "22"; ctx.fill();
        ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2); ctx.fillStyle = c + "44"; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = n.error ? "#fbeee2" : n.loading ? "#eceef4" : c; ctx.fill();
      ctx.strokeStyle = "rgba(20,22,35,.15)"; ctx.lineWidth = 1; ctx.stroke();
      if (n.loading) {
        const t = Date.now() / 500;
        ctx.beginPath(); ctx.arc(sx, sy, r, t, t + Math.PI * 1.3);
        ctx.strokeStyle = "#5c54e8"; ctx.lineWidth = 2; ctx.stroke();
      }
      if (camRef.current.z > 0.4) {
        const fs = Math.max(9, Math.min(11, 10 * camRef.current.z));
        ctx.font = `${fs}px system-ui`; ctx.textAlign = "center";
        const lbl = n.title.length > 24 ? n.title.slice(0, 22) + "…" : n.title;
        ctx.fillStyle = n.url === selUrlRef.current ? "#1a1a2a" : "rgba(60,60,90,.75)";
        ctx.fillText(lbl, sx, sy + r + fs + 2);
      }
    });
  }

  // ── crawl ─────────────────────────────────────────────────────
  async function fetchPage(url: string): Promise<PageData> {
    const r = await fetch(`/api/crawl?url=${encodeURIComponent(url)}&provider=${provider}`);
    if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
    return r.json();
  }

  // Serialize a Node into the persistence shape (matches /api/projects/[id]/append).
  function nodeToRow(n: Node) {
    return {
      url: n.url, title: n.title, depth: n.depth, parentUrl: n.parentUrl,
      summary: n.data?.summary || null,
      sections: n.data?.sections || [],
      categories: n.data?.categories || [],
      links: n.data?.links || [],
      infobox: n.data?.infobox || null,
      keyFacts: n.data?.keyFacts || null,
      aiProvider: n.data?.aiProvider || null,
      aiModel: n.data?.aiModel || null,
      error: n.error,
    };
  }

  // Flush queued saves to Neon. Called periodically and at end of crawl.
  async function flushAutosave() {
    const pid = projectIdRef.current;
    if (!pid) return;
    const pending = pendingSaveRef.current;
    if (!pending.pages.length && !pending.edges.length) return;
    const payload = { pages: pending.pages, edges: pending.edges };
    pendingSaveRef.current = { pages: [], edges: [] };
    try {
      await fetch(`/api/projects/${pid}/append`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Re-queue on failure so we try again next flush.
      pendingSaveRef.current.pages.push(...payload.pages);
      pendingSaveRef.current.edges.push(...payload.edges);
    }
  }

  // Process a single queue job (fetch + ingest + enqueue children).
  async function processJob(job: { url: string; depth: number; parentUrl: string | null }) {
    const node: Node = {
      url: job.url, title: titleFromUrl(job.url), depth: job.depth, parentUrl: job.parentUrl,
      data: null, loading: true, error: false, x: 0, y: 0, vx: 0, vy: 0,
    };
    nodesRef.current[job.url] = node;
    if (job.parentUrl) {
      const e = { src: job.parentUrl, dst: job.url };
      edgesRef.current.push(e);
      pendingSaveRef.current.edges.push(e);
    }
    placeNode(node);
    setStatus(`Fetching [D${job.depth}]: ${node.title}`);

    try {
      const data = await fetchPage(job.url);
      node.data = data; node.title = data.title || node.title; node.loading = false;

      // Canonicalize: if Fandom redirected, re-key the node under the canonical URL.
      if (data.canonicalUrl && data.canonicalUrl !== job.url) {
        delete nodesRef.current[job.url];
        nodesRef.current[data.canonicalUrl] = { ...node, url: data.canonicalUrl };
        edgesRef.current = edgesRef.current.map((e) => ({
          src: e.src === job.url ? data.canonicalUrl : e.src,
          dst: e.dst === job.url ? data.canonicalUrl : e.dst,
        }));
        visitedRef.current.add(data.canonicalUrl);
        node.url = data.canonicalUrl;
      }

      // Enqueue REAL outgoing links (ns=0 from MediaWiki).
      const origin = originOf(node.url);
      const knownPending = new Set(queueRef.current.map((q) => q.url));
      for (const t of data.links || []) {
        const u = urlFromTitle(origin, t);
        if (visitedRef.current.has(u) || knownPending.has(u)) continue;
        knownPending.add(u);
        queueRef.current.push({ url: u, depth: job.depth + 1, parentUrl: node.url });
      }
    } catch {
      node.loading = false; node.error = true;
    }

    pendingSaveRef.current.pages.push(nodeToRow(node));
    runForce(8);
  }

  async function crawlBFS(rootUrl: string) {
    const maxPages = maxP > 0 ? maxP : 999999;
    if (!queueRef.current.length) {
      queueRef.current = [{ url: rootUrl, depth: 0, parentUrl: null }];
    }
    crawlingRef.current = true; setCrawling(true);

    // Start (or continue) an autosave project.
    if (autosave && !projectIdRef.current) {
      try {
        const r = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: titleFromUrl(rootUrl), rootUrl, nodes: [], edges: [] }),
        });
        if (r.ok) projectIdRef.current = (await r.json()).id;
      } catch {}
    }

    const flushTimer = setInterval(() => { flushAutosave(); }, 2500);
    const concurrent = Math.max(1, Math.min(8, concurrency));

    // Worker pool: each worker pulls from queueRef until done or stopped or cap hit.
    const workers = Array.from({ length: concurrent }, async () => {
      while (crawlingRef.current && Object.keys(nodesRef.current).length < maxPages) {
        const job = queueRef.current.shift();
        if (!job) {
          // Queue empty for now; brief pause in case other workers add more.
          await new Promise((res) => setTimeout(res, 80));
          if (!queueRef.current.length) return;
          continue;
        }
        if (visitedRef.current.has(job.url)) continue;
        visitedRef.current.add(job.url);
        await processJob(job);
        progressRef.current = maxPages < 999999
          ? Math.min(100, Math.round(Object.keys(nodesRef.current).length / maxPages * 100))
          : 50;
        redraw(); rerender();
      }
    });

    await Promise.all(workers);
    clearInterval(flushTimer);
    await flushAutosave();

    crawlingRef.current = false; setCrawling(false);
    runForce(100); redraw(); rerender();
    const leftover = queueRef.current.length;
    const saved = projectIdRef.current ? ` · autosaved` : "";
    setStatus(`Done — ${Object.keys(nodesRef.current).length} pages, ${edgesRef.current.length} links${saved}.${leftover ? ` (${leftover} unvisited — click Resume or raise max)` : ""}`);
    setTimeout(() => { progressRef.current = 0; rerender(); }, 2000);
  }

  async function startCrawl() {
    const url = urlIn.trim();
    if (!url.includes("fandom.com")) { setStatus("Enter a valid fandom.com/wiki/ URL."); return; }
    nodesRef.current = {}; edgesRef.current = []; queueRef.current = [];
    visitedRef.current = new Set(); selUrlRef.current = null;
    camRef.current = { x: 0, y: 0, z: 1 }; progressRef.current = 0;
    projectIdRef.current = null;
    pendingSaveRef.current = { pages: [], edges: [] };
    rerender();
    // kick anim loop
    const loop = () => {
      if (Object.values(nodesRef.current).some((n) => n.loading)) {
        redraw(); requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
    await crawlBFS(url);
  }

  // Resume a paused / loaded crawl by re-seeding the queue from existing
  // pages' real outgoing links that haven't been visited yet.
  async function resumeCrawl() {
    const root = Object.values(nodesRef.current).find((n) => n.depth === 0);
    if (!root) { setStatus("Nothing to resume."); return; }
    const visited = new Set(Object.keys(nodesRef.current));
    visitedRef.current = visited;
    const known = new Set(queueRef.current.map((q) => q.url));
    for (const n of Object.values(nodesRef.current)) {
      const origin = originOf(n.url);
      for (const t of n.data?.links || []) {
        const u = urlFromTitle(origin, t);
        if (visited.has(u) || known.has(u)) continue;
        known.add(u);
        queueRef.current.push({ url: u, depth: n.depth + 1, parentUrl: n.url });
      }
    }
    if (!queueRef.current.length) { setStatus("Nothing to resume — all links already crawled."); return; }
    setStatus(`Resuming with ${queueRef.current.length} queued pages…`);
    const loop = () => {
      if (Object.values(nodesRef.current).some((n) => n.loading)) {
        redraw(); requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
    await crawlBFS(root.url);
  }
  function stopCrawl() { crawlingRef.current = false; }

  // ── projects (Neon) ───────────────────────────────────────────
  const [projects, setProjects] = useState<any[]>([]);
  const [projModal, setProjModal] = useState(false);

  async function saveProject() {
    const root = Object.values(nodesRef.current).find((n) => n.depth === 0);
    if (!root) { alert("Nothing to save."); return; }
    const payload = {
      name: root.title,
      rootUrl: root.url,
      nodes: Object.values(nodesRef.current).map((n) => ({
        url: n.url, title: n.title, depth: n.depth, parentUrl: n.parentUrl,
        summary: n.data?.summary || null,
        sections: n.data?.sections || [],
        categories: n.data?.categories || [],
        links: n.data?.links || [],
        infobox: n.data?.infobox || null,
        keyFacts: n.data?.keyFacts || null,
        aiProvider: n.data?.aiProvider || null,
        aiModel: n.data?.aiModel || null,
        error: n.error,
      })),
      edges: edgesRef.current,
    };
    const r = await fetch("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { alert("Save failed."); return; }
    const { id } = await r.json();
    setStatus(`Saved "${root.title}" (${payload.nodes.length} pages) — id=${id}`);
  }

  async function openProjects() {
    const r = await fetch("/api/projects");
    const list = r.ok ? await r.json() : [];
    setProjects(list); setProjModal(true);
  }
  async function loadProject(id: string) {
    const r = await fetch(`/api/projects/${id}`);
    if (!r.ok) { alert("Load failed."); return; }
    const { project, nodes, edges } = await r.json();
    nodesRef.current = {}; edgesRef.current = edges || []; queueRef.current = [];
    visitedRef.current = new Set(nodes.map((n: any) => n.url));
    selUrlRef.current = null;
    projectIdRef.current = id;
    pendingSaveRef.current = { pages: [], edges: [] };
    if (project?.root_url) setUrlIn(project.root_url);
    for (const n of nodes) {
      const node: Node = {
        url: n.url, title: n.title, depth: n.depth, parentUrl: n.parentUrl,
        data: { url: n.url, canonicalUrl: n.url, title: n.title, summary: n.summary || "",
                sections: n.sections || [], categories: n.categories || [],
                links: n.links || [], infobox: n.infobox || undefined,
                keyFacts: n.keyFacts || undefined, aiProvider: n.aiProvider, aiModel: n.aiModel },
        loading: false, error: !!n.error, x: 0, y: 0, vx: 0, vy: 0,
      };
      placeNode(node);
      nodesRef.current[n.url] = node;
    }
    runForce(100); redraw(); rerender();
    setProjModal(false);
    setStatus(`Loaded "${project.name}" (${nodes.length} pages)`);
  }
  async function delProject(id: string) {
    if (!confirm("Delete this project?")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    openProjects();
  }

  // ── canvas events ─────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const onDown = (e: MouseEvent) => { dragRef.current = { on: true, sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y }; };
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.on) return;
      camRef.current.x = dragRef.current.cx + (e.clientX - dragRef.current.sx) / camRef.current.z;
      camRef.current.y = dragRef.current.cy + (e.clientY - dragRef.current.sy) / camRef.current.z;
      redraw();
    };
    const onUp = (e: MouseEvent) => {
      if (!dragRef.current.on) return;
      const moved = Math.abs(e.clientX - dragRef.current.sx) + Math.abs(e.clientY - dragRef.current.sy);
      dragRef.current.on = false;
      if (moved < 5) {
        const rect = cv.getBoundingClientRect();
        const [wx, wy] = s2w(e.clientX - rect.left, e.clientY - rect.top);
        for (const n of Object.values(nodesRef.current)) {
          const r = rad(n.depth) * 1.8;
          if ((n.x - wx) ** 2 + (n.y - wy) ** 2 < r * r) { scrollToCard(n.url); break; }
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camRef.current.z = Math.max(0.1, Math.min(5, camRef.current.z * (e.deltaY > 0 ? 0.87 : 1.15)));
      redraw();
    };
    cv.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cv.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => redraw()); if (wrapRef.current) ro.observe(wrapRef.current);
    redraw();
    return () => {
      cv.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cv.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, []);

  // When returning from canon view, the network wrap was display:none so
  // the canvas shrank to 0x0. Force a redraw once the layout settles.
  useEffect(() => {
    if (viewMode === "network") {
      const id = requestAnimationFrame(() => redraw());
      return () => cancelAnimationFrame(id);
    }
  }, [viewMode]);

  function scrollToCard(url: string) {
    selUrlRef.current = url; redraw(); rerender();
    const el = document.getElementById(cardId(url));
    if (el) { el.classList.remove("collapsed"); el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  // ── render ────────────────────────────────────────────────────
  const nodes = Object.values(nodesRef.current);
  const roots = nodes.filter((n) => !n.parentUrl);

  function TreeNode({ n }: { n: Node }) {
    const kids = nodes.filter((c) => c.parentUrl === n.url);
    return (
      <div>
        <div className={`tn-row${selUrlRef.current === n.url ? " sel" : ""}`} onClick={() => scrollToCard(n.url)}>
          <span className="tn-dot" style={{ background: col(n.depth) }} />
          <span className="tn-title" title={n.url}>{n.title}</span>
          {n.loading && <span className="spin" />}
        </div>
        {kids.length > 0 && <div className="tn-children">{kids.map((c) => <TreeNode key={c.url} n={c} />)}</div>}
      </div>
    );
  }

  const tab: "crawl" | "sitemap" | "canon" =
    viewMode === "canon" ? "sitemap"
    : viewMode === "canon-analysis" ? "canon"
    : "crawl";

  function switchTab(t: "crawl" | "sitemap" | "canon") {
    if (t === "crawl") {
      if (viewMode !== "network" && viewMode !== "tree") setViewMode("network");
    } else if (t === "sitemap") {
      setViewMode("canon");
    } else {
      setViewMode("canon-analysis");
    }
  }

  return (
    <>
      <div id="topbar">
        {/* Tab switcher */}
        <div style={{ display: "flex", gap: 2, background: "#eceef4", padding: 2, borderRadius: 6 }}>
          {(["crawl", "sitemap", "canon"] as const).map((t) => (
            <button
              key={t}
              className={`tbtn${tab === t ? " active" : ""}`}
              onClick={() => switchTab(t)}
              style={{
                background: tab === t ? "#fff" : "transparent",
                border: tab === t ? "1px solid #d9dbe6" : "1px solid transparent",
                fontWeight: tab === t ? 700 : 500,
                textTransform: "capitalize",
              }}
            >{t}</button>
          ))}
        </div>
        <input type="text" value={urlIn} onChange={(e) => setUrlIn(e.target.value)} placeholder="https://[wiki].fandom.com/wiki/Page" />

        {/* Crawl-only controls */}
        {tab === "crawl" && <>
          <input type="number" value={maxP} min={0} onChange={(e) => setMaxP(parseInt(e.target.value) || 0)} title="Max pages (0 = unlimited)" />
          <span className="tlabel">max (0=∞)</span>
          <input type="number" value={concurrency} min={1} max={8} onChange={(e) => setConcurrency(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))} title="Parallel fetches (1-8)" />
          <span className="tlabel">parallel</span>
          <label className="tlabel" style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer" }} title="Save to Neon as you crawl">
            <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} />
            autosave
          </label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as LLMProvider)}
            className="tbtn"
            title="AI provider for summary/key-facts extraction (structure is always from MediaWiki)"
            style={{ appearance: "auto" }}
          >
            <option value="none">AI: off (raw wiki)</option>
            {availProviders.includes("claude") && (
              <option value="claude">Claude · {providerDefaults.claude || "sonnet"}</option>
            )}
            {availProviders.includes("gemini") && (
              <option value="gemini">Gemini · {providerDefaults.gemini || "3.1-pro"}</option>
            )}
          </select>
          <button className="tbtn primary" disabled={crawling} onClick={startCrawl}>Crawl</button>
          <button className="tbtn" disabled={crawling || !nodes.length} onClick={resumeCrawl} title="Continue crawling uncrawled links">Resume</button>
          {crawling && <button className="tbtn danger" onClick={stopCrawl}>Stop</button>}
        </>}

        <div style={{ flex: 1 }} />

        {/* Crawl-only right-side controls */}
        {tab === "crawl" && <>
          <button
            className={`tbtn${viewMode === "tree" ? " active" : ""}`}
            onClick={() => setViewMode(viewMode === "network" ? "tree" : "network")}
          >
            {viewMode === "network" ? "Show Tree" : "Show Network"}
          </button>
          <button className="tbtn" onClick={() => setAllExpanded((v) => !v)}>{allExpanded ? "Collapse All" : "Expand All"}</button>
          <button className="tbtn" onClick={saveProject}>💾 Save</button>
          <button className="tbtn" onClick={openProjects}>📁 Projects</button>
        </>}
      </div>
      <div id="progress" style={{ width: progressRef.current + "%" }} />
      <div id="main">
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: viewMode === "canon" ? "block" : "none",
          }}
        >
          <ProfilerPanel urlIn={urlIn} />
        </div>
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: viewMode === "canon-analysis" ? "block" : "none",
          }}
        >
          <CanonPanel urlIn={urlIn} />
        </div>
        <div id="left" style={{ display: viewMode === "canon" || viewMode === "canon-analysis" ? "none" : undefined }}>
          <div id="left-hdr">
            <span>{viewMode === "network" ? "Hyperlink Network" : "Hyperlink Tree"} — {nodes.length} nodes</span>
            <div id="legend">
              <div className="leg"><div className="leg-dot" style={{ background: "#5c54e8" }} />Root</div>
              <div className="leg"><div className="leg-dot" style={{ background: "#2bbfbf" }} />D1</div>
              <div className="leg"><div className="leg-dot" style={{ background: "#e07a38" }} />D2</div>
              <div className="leg"><div className="leg-dot" style={{ background: "#d9507a" }} />D3+</div>
            </div>
          </div>
          <div id="net-wrap" ref={wrapRef} style={{ display: viewMode === "network" ? undefined : "none" }}>
            <canvas id="netCanvas" ref={canvasRef} />
            <div id="chint">Drag · Scroll=zoom · Click=view</div>
          </div>
          <div id="treeView" style={{ display: viewMode === "tree" ? "block" : "none" }}>
            {roots.map((r) => <TreeNode key={r.url} n={r} />)}
          </div>
        </div>
        <div id="right" style={{ display: viewMode === "canon" || viewMode === "canon-analysis" ? "none" : undefined }}>
          <div id="right-hdr">
            All pages: <b>{nodes.length}</b>&nbsp;·&nbsp;Links: <b>{edgesRef.current.length}</b>&nbsp;·&nbsp;Queue: <b>{queueRef.current.length}</b>
          </div>
          <div id="content-list">
            {nodes.map((n) => (
              <PageCard key={n.url} n={n} allExpanded={allExpanded} onLinkClick={(t) => {
                const u = urlFromTitle(originOf(n.url), t);
                scrollToCard(u);
              }} />
            ))}
          </div>
        </div>
      </div>
      <div id="statusbar"><span>{status}</span><span /></div>

      <div id="proj-modal" className={projModal ? "open" : ""}>
        <div id="proj-box">
          <div id="proj-box-hdr">
            <span>Saved Projects (Neon)</span>
            <button className="tbtn" onClick={() => setProjModal(false)}>✕ Close</button>
          </div>
          <div id="proj-list">
            {!projects.length && <p style={{ padding: 16, color: "#555" }}>No saved projects yet.</p>}
            {projects.map((p) => (
              <div key={p.id} className="proj-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="proj-name">{p.name}</div>
                  <div className="proj-meta">{p.node_count} pages · {new Date(p.created_at).toLocaleDateString()}</div>
                  <div className="proj-url">{p.root_url}</div>
                </div>
                <div className="proj-btns">
                  <button className="tbtn" onClick={() => loadProject(p.id)}>Load</button>
                  <button className="tbtn danger" onClick={() => delProject(p.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function PageCard({ n, allExpanded, onLinkClick }:
  { n: Node; allExpanded: boolean; onLinkClick: (title: string) => void }) {
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => { setCollapsed(!allExpanded); }, [allExpanded]);
  return (
    <div className={`page-card${collapsed ? " collapsed" : ""}`} id={cardId(n.url)}>
      <div className="card-hdr" onClick={() => setCollapsed((v) => !v)}>
        <span className="card-dot" style={{ background: col(n.depth) }} />
        <span className="card-title">{n.title}</span>
        {n.loading && <span className="spin" />}
        <span className="card-tog">▼</span>
      </div>
      <div className="card-body">
        {n.error && <p className="err-msg">Failed to load. <a className="ext-link" href={n.url} target="_blank" rel="noreferrer">Open on Fandom ↗</a></p>}
        {!n.error && n.data && (
          <>
            {n.data.summary && <p>{n.data.summary}</p>}

            {n.data.aiProvider && n.data.aiProvider !== "none" && (
              <p style={{ fontSize: 10, color: "#555", marginTop: 2 }}>
                Narrative by <b style={{ color: "#7a74ff" }}>{n.data.aiProvider}</b>
                {n.data.aiModel ? ` (${n.data.aiModel})` : ""} · structure from MediaWiki
              </p>
            )}

            {n.data.keyFacts && n.data.keyFacts.length > 0 && (
              <div className="sec">
                <div className="sec-h">Key facts (AI, grounded in source)</div>
                <ul style={{ paddingLeft: 18, margin: "3px 0" }}>
                  {n.data.keyFacts.map((f, i) => <li key={i} style={{ margin: "2px 0" }}>{f}</li>)}
                </ul>
              </div>
            )}

            {n.data.categories?.length > 0 && (
              <div className="sec">
                <div className="sec-h">Categories (real)</div>
                <div className="link-tags">
                  {n.data.categories.map((c) => <span key={c} className="cat-tag">{c}</span>)}
                </div>
              </div>
            )}

            {n.data.infobox && Object.keys(n.data.infobox).length > 0 && (
              <div className="sec">
                <div className="sec-h">Infobox (from page)</div>
                <table className="infobox-tbl"><tbody>
                  {Object.entries(n.data.infobox).map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td>{v}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}

            {n.data.sections?.length > 0 && (
              <div className="sec">
                <div className="sec-h">Sections (real)</div>
                {n.data.sections.map((s, i) => (
                  <p key={i} style={{ paddingLeft: (s.level - 1) * 10 }}>
                    <span className="sec-h" style={{ textTransform: "none", color: "#aab" }}>{s.heading}</span>
                    <span className="lvl">H{s.level}</span>
                  </p>
                ))}
              </div>
            )}

            {n.data.links?.length > 0 && (
              <div className="sec">
                <div className="sec-h">Outgoing links (real, ns=0)</div>
                <div className="link-tags">
                  {n.data.links.map((t) => (
                    <span key={t} className="link-tag" onClick={() => onLinkClick(t)}>{t}</span>
                  ))}
                </div>
              </div>
            )}

            <a className="ext-link" href={n.url} target="_blank" rel="noreferrer">Open on Fandom ↗</a>
          </>
        )}
      </div>
    </div>
  );
}
