"use client";
// app/canon-panel.tsx
// Canon Logic view: LLM explains how THIS IP's canon is organized.
// Left column: organization tree + per-type schemas.
// Right column: meta-logic explanation (markdown).
// Export: HTML or Markdown (both importable into Google Docs).
import { useCallback, useState } from "react";

type Provider = "gemini" | "claude";
type CanonNode = { label: string; note?: string; children?: CanonNode[] };
type TypeSchema = {
  type: string;
  template?: string;
  fields: string[];
  commonSections: string[];
  categoryAxes: string[];
  examples: string[];
  notes?: string;
};
type Analysis = {
  tree: CanonNode[];
  explanation: string;
  perType: TypeSchema[];
  provider: Provider;
  model: string;
  meta?: {
    sitename?: string;
    mainpage?: string;
    articles?: number;
    navCount?: number;
    topCategories?: number;
    detailedPages?: number;
    canonSignalCategories?: number;
  };
};

const MODEL_OPTIONS: { id: string; provider: Provider; label: string }[] = [
  { id: "gemini-3.1-pro-preview", provider: "gemini", label: "Gemini 3.1 Pro Preview (default)" },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", provider: "claude", label: "Claude Opus 4.7" },
];

function deriveOrigin(input: string): string {
  try { return new URL(input).origin; } catch { return ""; }
}

export default function CanonPanel({ urlIn }: { urlIn: string }) {
  const origin = deriveOrigin(urlIn);
  const [modelId, setModelId] = useState<string>("gemini-3.1-pro-preview");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string>("");
  const [progress, setProgress] = useState<string[]>([]);
  const [thinking, setThinking] = useState<string>("");
  const [showThinking, setShowThinking] = useState<boolean>(true);

  const run = useCallback(async () => {
    if (!origin) return;
    setLoading(true);
    setError("");
    setAnalysis(null);
    setProgress([]);
    setThinking("");
    try {
      const opt = MODEL_OPTIONS.find((m) => m.id === modelId)!;
      const r = await fetch("/api/canon/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, provider: opt.provider, model: opt.id }),
      });
      if (!r.ok || !r.body) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`);
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
          } else if (ev.event === "thinking") {
            setThinking((t) => t + String(ev.data?.text || ""));
          } else if (ev.event === "result") {
            setAnalysis(ev.data as Analysis);
          } else if (ev.event === "error") {
            setError(String(ev.data?.error || "stream error"));
          }
        }
      }
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }, [origin, modelId]);

  if (!origin) {
    return <div style={{ padding: 16, color: "#888" }}>Enter a Fandom URL in the top bar.</div>;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(320px, 46%) 1fr",
        height: "100%",
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* Left: tree + per-type schemas */}
      <div style={{ borderRight: "1px solid #eceef4", overflowY: "auto", padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#2a2a3f" }}>Canon organization</div>
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
          <button className="tbtn primary" onClick={run} disabled={loading}>
            {loading ? "Analyzing…" : analysis ? "Re-analyze" : "Analyze"}
          </button>
          {analysis && (
            <>
              <button
                className="tbtn"
                onClick={() => downloadHtml(analysis, origin)}
                title="Download a styled .html you can upload to Google Docs (File > Open > Upload)"
              >
                ⬇ HTML
              </button>
              <button
                className="tbtn"
                onClick={() => downloadMarkdown(analysis, origin)}
                title="Download as Markdown (.md)"
              >
                ⬇ Markdown
              </button>
            </>
          )}
        </div>

        {error && (
          <div style={{
            background: "#fbeee2", border: "1px solid #e07a38", color: "#a04a18",
            padding: "6px 10px", borderRadius: 6, marginBottom: 10, fontSize: 11, whiteSpace: "pre-wrap",
          }}>{error}</div>
        )}

        {!analysis && !loading && !error && (
          <div className="tlabel">
            Scans the wiki&#39;s full sitemap, top ~80 categories, sample members,
            and the infobox + sections + categories of ~30 representative pages,
            then asks the chosen model to describe how this IP&#39;s canon is
            organized — including per-item-type fields.
          </div>
        )}

        {/* Live progress + streaming thinking (visible while loading AND after) */}
        {(loading || progress.length > 0 || thinking) && (
          <div style={{ marginBottom: 12 }}>
            {progress.length > 0 && (
              <div style={{
                background: "#f4f5f9", border: "1px solid #eceef4", borderRadius: 6,
                padding: "6px 10px", marginBottom: 6, fontSize: 11,
                fontFamily: "monospace", color: "#444",
                maxHeight: 80, overflowY: "auto",
              }}>
                {progress.map((p, i) => (
                  <div key={i}>
                    <span style={{ color: "#5c54e8" }}>›</span> {p}
                  </div>
                ))}
                {loading && <div style={{ color: "#888" }}>…</div>}
              </div>
            )}
            {thinking && (
              <div style={{ border: "1px solid #e5d6f7", borderRadius: 6, background: "#faf7ff" }}>
                <div
                  onClick={() => setShowThinking((v) => !v)}
                  style={{
                    cursor: "pointer", padding: "6px 10px", fontSize: 11,
                    fontWeight: 700, color: "#7a4ad0", display: "flex",
                    alignItems: "center", gap: 6, borderBottom: showThinking ? "1px solid #e5d6f7" : "none",
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
          </div>
        )}

        {analysis && (
          <>
            {analysis.meta && (
              <div className="tlabel" style={{ marginBottom: 10 }}>
                {analysis.meta.sitename}{analysis.meta.articles ? ` · ${analysis.meta.articles.toLocaleString()} articles` : ""}
                {" · "}nav: {analysis.meta.navCount || 0}
                {" · "}cats sampled: {analysis.meta.topCategories || 0}
                {" · "}pages fingerprinted: {analysis.meta.detailedPages || 0}
                {analysis.meta.canonSignalCategories ? ` · canon-signal cats: ${analysis.meta.canonSignalCategories}` : ""}
              </div>
            )}

            <Section title="Organization tree">
              {analysis.tree.length === 0
                ? <div className="tlabel">No tree returned.</div>
                : analysis.tree.map((n, i) => <TreeNode key={i} node={n} depth={0} />)}
            </Section>

            <Section title={`Per-type schema (${analysis.perType.length})`}>
              {analysis.perType.length === 0
                ? <div className="tlabel">No per-type schema returned.</div>
                : analysis.perType.map((t, i) => <TypeCard key={i} t={t} />)}
            </Section>
          </>
        )}
      </div>

      {/* Right: meta explanation */}
      <div style={{ overflowY: "auto", padding: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#2a2a3f", marginBottom: 8 }}>
          How this IP builds its canon
        </div>
        {analysis ? (
          <div>
            <div className="tlabel" style={{ marginBottom: 10 }}>
              {analysis.provider} · {analysis.model}
            </div>
            <MarkdownBlock text={analysis.explanation} />
          </div>
        ) : (
          <div className="tlabel">The explanation will appear here after analysis.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: "#5c54e8", textTransform: "uppercase",
        letterSpacing: ".06em", marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
}

function TreeNode({ node, depth }: { node: CanonNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "2px 0" }}>
        <span
          onClick={() => hasKids && setOpen((v) => !v)}
          style={{
            cursor: hasKids ? "pointer" : "default", fontSize: 10,
            color: "#5c54e8", width: 12, userSelect: "none", paddingTop: 2,
          }}
        >{hasKids ? (open ? "▼" : "▶") : "·"}</span>
        <div>
          <div style={{
            fontSize: depth === 0 ? 13 : 12,
            fontWeight: depth === 0 ? 700 : depth === 1 ? 600 : 500,
            color: "#2a2a3f",
            textTransform: depth === 0 ? "uppercase" : "none",
            letterSpacing: depth === 0 ? ".04em" : undefined,
          }}>{node.label}</div>
          {node.note && (
            <div style={{ fontSize: 11, color: "#666", marginTop: 1, lineHeight: 1.35 }}>
              {node.note}
            </div>
          )}
        </div>
      </div>
      {open && hasKids && (
        <div style={{ borderLeft: "1px solid #eceef4", marginLeft: 6, paddingLeft: 4 }}>
          {kids.map((c, i) => <TreeNode key={i} node={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

function TypeCard({ t }: { t: TypeSchema }) {
  return (
    <div style={{
      border: "1px solid #eceef4", borderRadius: 6, padding: 10, marginBottom: 8, background: "#fafbff",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#2a2a3f" }}>{t.type}</div>
        {t.template && (
          <div style={{ fontSize: 11, color: "#5c54e8", fontFamily: "monospace" }}>
            {t.template}
          </div>
        )}
      </div>
      {t.notes && (
        <div style={{ fontSize: 11, color: "#555", marginTop: 4, fontStyle: "italic" }}>
          {t.notes}
        </div>
      )}
      {t.fields.length > 0 && <KVBlock label="Fields" items={t.fields} mono />}
      {t.commonSections.length > 0 && <KVBlock label="Sections" items={t.commonSections} />}
      {t.categoryAxes.length > 0 && <KVBlock label="Category axes" items={t.categoryAxes} />}
      {t.examples.length > 0 && <KVBlock label="Examples" items={t.examples} italic />}
    </div>
  );
}

function KVBlock({ label, items, mono, italic }: {
  label: string; items: string[]; mono?: boolean; italic?: boolean;
}) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
        {items.map((s, i) => (
          <span key={i} style={{
            fontSize: 11,
            fontFamily: mono ? "monospace" : undefined,
            fontStyle: italic ? "italic" : undefined,
            background: "#fff", border: "1px solid #eceef4", color: "#2a2a3f",
            padding: "1px 6px", borderRadius: 10,
          }}>{s}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown (lightweight)
// ---------------------------------------------------------------------------

function MarkdownBlock({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div style={{ fontSize: 13, color: "#2a2a3f", lineHeight: 1.55 }}>
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

function renderBlock(block: string, key: number): JSX.Element {
  const trimmed = block.trim();
  if (!trimmed) return <div key={key} />;
  const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (h) {
    const level = h[1].length;
    const size = [17, 15, 14, 13][level - 1];
    return <div key={key} style={{ fontSize: size, fontWeight: 700, color: "#2a2a3f", margin: "14px 0 6px" }}>{renderInline(h[2])}</div>;
  }
  const lines = trimmed.split(/\n/);
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return (
      <ul key={key} style={{ margin: "6px 0", paddingLeft: 20 }}>
        {lines.map((l, i) => <li key={i} style={{ margin: "2px 0" }}>{renderInline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
      </ul>
    );
  }
  return <p key={key} style={{ margin: "8px 0" }}>{renderInline(trimmed)}</p>;
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function filenameSafe(s: string): string {
  return s.replace(/[^a-z0-9\-_.]+/gi, "_").replace(/^_+|_+$/g, "");
}

function downloadBlob(name: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function treeToMarkdown(nodes: CanonNode[], depth = 0): string {
  return nodes.map((n) => {
    const pad = "  ".repeat(depth);
    const note = n.note ? ` — *${n.note}*` : "";
    const head = `${pad}- **${n.label}**${note}`;
    const kids = n.children && n.children.length
      ? "\n" + treeToMarkdown(n.children, depth + 1)
      : "";
    return head + kids;
  }).join("\n");
}

function treeToHtml(nodes: CanonNode[]): string {
  if (!nodes.length) return "";
  return (
    "<ul>" +
    nodes.map((n) => {
      const note = n.note ? ` <em style="color:#666;">— ${escHtml(n.note)}</em>` : "";
      const kids = n.children && n.children.length ? treeToHtml(n.children) : "";
      return `<li><strong>${escHtml(n.label)}</strong>${note}${kids}</li>`;
    }).join("") +
    "</ul>"
  );
}

function typeToMarkdown(t: TypeSchema): string {
  const lines: string[] = [];
  lines.push(`### ${t.type}${t.template ? ` — \`${t.template}\`` : ""}`);
  if (t.notes) lines.push(`*${t.notes}*`);
  if (t.fields.length) lines.push(`**Fields:** ${t.fields.map((f) => "`" + f + "`").join(", ")}`);
  if (t.commonSections.length) lines.push(`**Sections:** ${t.commonSections.join(" · ")}`);
  if (t.categoryAxes.length) lines.push(`**Category axes:** ${t.categoryAxes.join(" · ")}`);
  if (t.examples.length) lines.push(`**Examples:** ${t.examples.map((e) => "_" + e + "_").join(", ")}`);
  return lines.join("\n\n");
}

function typeToHtml(t: TypeSchema): string {
  const parts: string[] = [];
  parts.push(`<h3>${escHtml(t.type)}${t.template ? ` <code>${escHtml(t.template)}</code>` : ""}</h3>`);
  if (t.notes) parts.push(`<p><em>${escHtml(t.notes)}</em></p>`);
  const row = (label: string, items: string[], mono = false) =>
    items.length
      ? `<p><strong>${label}:</strong> ${items.map((i) => mono ? `<code>${escHtml(i)}</code>` : escHtml(i)).join(" · ")}</p>`
      : "";
  parts.push(row("Fields", t.fields, true));
  parts.push(row("Sections", t.commonSections));
  parts.push(row("Category axes", t.categoryAxes));
  parts.push(row("Examples", t.examples));
  return parts.filter(Boolean).join("\n");
}

function downloadMarkdown(a: Analysis, origin: string) {
  const title = a.meta?.sitename || origin;
  const parts: string[] = [];
  parts.push(`# Canon Logic — ${title}`);
  parts.push(`*Origin: ${origin}*`);
  parts.push(`*Model: ${a.provider} · ${a.model}*`);
  if (a.meta) {
    const m = a.meta;
    parts.push(`*Sample: ${m.articles || 0} articles · nav ${m.navCount || 0} · cats ${m.topCategories || 0} · pages ${m.detailedPages || 0}*`);
  }
  parts.push("");
  parts.push(`## Meta explanation`);
  parts.push(a.explanation || "");
  parts.push("");
  parts.push(`## Organization tree`);
  parts.push(treeToMarkdown(a.tree));
  parts.push("");
  parts.push(`## Per-type schema`);
  for (const t of a.perType) {
    parts.push(typeToMarkdown(t));
    parts.push("");
  }
  downloadBlob(
    `canon-${filenameSafe(title)}.md`,
    "text/markdown;charset=utf-8",
    parts.join("\n")
  );
}

function downloadHtml(a: Analysis, origin: string) {
  const title = a.meta?.sitename || origin;
  // Inline markdown-to-HTML for the explanation.
  const expl = markdownToHtml(a.explanation || "");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Canon Logic — ${escHtml(title)}</title>
<style>
  body { font: 14px/1.55 -apple-system, system-ui, Segoe UI, sans-serif; color:#222; max-width: 820px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin-bottom: 2px; }
  h2 { font-size: 20px; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 32px; }
  h3 { font-size: 16px; margin-top: 20px; }
  .meta { color:#666; font-size: 12px; margin-bottom: 20px; }
  ul { padding-left: 22px; }
  li { margin: 3px 0; }
  code { background:#f4f5f9; padding:1px 4px; border-radius:3px; font-size:.9em; }
  .type { border:1px solid #e5e7ef; border-radius:6px; padding:10px 14px; margin:10px 0; background:#fafbff; }
  em { color:#555; }
</style></head><body>
<h1>Canon Logic — ${escHtml(title)}</h1>
<div class="meta">
  Origin: ${escHtml(origin)}<br>
  Model: ${escHtml(a.provider)} · ${escHtml(a.model)}<br>
  ${a.meta ? `Sample: ${a.meta.articles || 0} articles · nav ${a.meta.navCount || 0} · cats ${a.meta.topCategories || 0} · pages ${a.meta.detailedPages || 0}` : ""}
</div>
<h2>Meta explanation</h2>
${expl}
<h2>Organization tree</h2>
${treeToHtml(a.tree)}
<h2>Per-type schema</h2>
${a.perType.map((t) => `<div class="type">${typeToHtml(t)}</div>`).join("\n")}
</body></html>`;
  downloadBlob(
    `canon-${filenameSafe(title)}.html`,
    "text/html;charset=utf-8",
    html
  );
}

function markdownToHtml(md: string): string {
  // Minimal: headings, lists, bold, italic, code, paragraphs.
  const blocks = md.split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return "";
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const level = Math.min(Math.max(h[1].length + 1, 2), 5); // h1 reserved for title
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
  return escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// ---------------------------------------------------------------------------
// SSE line parser (client-side) — matches server's `event:` + `data:` lines.
// ---------------------------------------------------------------------------
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
