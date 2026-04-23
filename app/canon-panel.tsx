"use client";
// app/canon-panel.tsx
// Canon Logic view — REAL inventory, not LLM-invented schema.
// Layout: 2/3 inventory (left) · 1/3 meta explanation (right).
//
// Every page title, URL, infobox template name, field key and field VALUE
// shown here comes straight from MediaWiki's wikitext. The LLM only narrates
// the meta-logic on the right pane. It never rewrites wiki content.
//
// Streams from /api/canon/inventory as SSE. Events:
//   meta / progress / group_start / group_type / page / group_end /
//   thinking / explanation / error / done

import { useCallback, useRef, useState } from "react";

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

export default function CanonPanel({ urlIn }: { urlIn: string }) {
  const origin = deriveOrigin(urlIn);
  const [modelId, setModelId] = useState<string>("gemini-3.1-pro-preview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [explanation, setExplanation] = useState<string>("");
  const [thinking, setThinking] = useState<string>("");
  const [showThinking, setShowThinking] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Use a ref mirror for mutating groups during stream to avoid stale state.
  const groupsRef = useRef<Group[]>([]);

  const upsertGroup = useCallback((updater: (prev: Group[]) => Group[]) => {
    groupsRef.current = updater(groupsRef.current);
    setGroups(groupsRef.current.slice());
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
      const r = await fetch("/api/canon/inventory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, provider: opt.provider, model: opt.id }),
        signal: ctl.signal,
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
          switch (ev.event) {
            case "progress":
              setProgress((p) => [...p, String(ev.data?.step || "")]);
              break;
            case "meta":
              setMeta(ev.data as Meta);
              break;
            case "group_start": {
              const g: Group = {
                gid: ev.data.gid,
                category: ev.data.category,
                totalMembers: ev.data.totalMembers,
                sampled: ev.data.sampled,
                pages: [],
              };
              upsertGroup((prev) => [...prev, g]);
              break;
            }
            case "group_type": {
              const { gid, template, matched, total, share, isType } = ev.data;
              upsertGroup((prev) =>
                prev.map((g) =>
                  g.gid === gid
                    ? { ...g, template, matched, total, share, isType }
                    : g
                )
              );
              break;
            }
            case "page": {
              const p: PageRow = {
                gid: ev.data.gid,
                title: ev.data.title,
                url: ev.data.url,
                template: ev.data.template,
                fields: ev.data.fields || [],
                lead: ev.data.lead || "",
                sections: ev.data.sections || [],
              };
              upsertGroup((prev) =>
                prev.map((g) => (g.gid === p.gid ? { ...g, pages: [...g.pages, p] } : g))
              );
              break;
            }
            case "group_end": {
              const { gid } = ev.data;
              upsertGroup((prev) =>
                prev.map((g) => (g.gid === gid ? { ...g, done: true } : g))
              );
              break;
            }
            case "thinking":
              setThinking((t) => t + String(ev.data?.text || ""));
              break;
            case "explanation":
              setExplanation(String(ev.data?.text || ""));
              break;
            case "error":
              setError(String(ev.data?.error || "stream error"));
              break;
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "failed");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [origin, modelId, upsertGroup]);

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
          {!loading ? (
            <button className="tbtn primary" onClick={run}>
              {groups.length ? "Re-scan" : "Scan wiki"}
            </button>
          ) : (
            <button className="tbtn" onClick={stop}>Stop</button>
          )}
          {groups.length > 0 && !loading && (
            <>
              <button className="tbtn" onClick={() => downloadHtml(groups, explanation, meta, origin)}
                title="Download a styled .html you can upload to Google Docs">⬇ HTML</button>
              <button className="tbtn" onClick={() => downloadMarkdown(groups, explanation, meta, origin)}
                title="Download as Markdown">⬇ Markdown</button>
            </>
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
          : <div className="tlabel">{loading ? "Waiting for the inventory to finish…" : "Scan the wiki to generate the explanation."}</div>}
      </div>
    </div>
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
  return (
    <div style={{ borderTop: "1px solid #f1f3fa" }}>
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
              fontSize: 12, color: "#2a2a3f", whiteSpace: "pre-wrap",
              lineHeight: 1.5, marginBottom: 10, borderLeft: "2px solid #eceef4",
              paddingLeft: 8,
            }}>{p.lead}</div>
          )}
          {hasSections && p.sections.map((s, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{
                fontSize: 12, fontWeight: 700, color: "#5c54e8",
                marginBottom: 3,
                paddingLeft: (s.level - 2) * 10,
              }}>{s.heading}</div>
              <div style={{
                fontSize: 12, color: "#2a2a3f", whiteSpace: "pre-wrap",
                lineHeight: 1.5, paddingLeft: (s.level - 2) * 10 + 4,
                borderLeft: "2px solid #eceef4", marginLeft: (s.level - 2) * 10,
              }}>{s.text}</div>
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

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div style={{ fontSize: 11, color: "#5c54e8", fontFamily: "monospace", paddingTop: 2 }}>{k}</div>
      <div style={{ fontSize: 11, color: "#2a2a3f", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {v || <span style={{ color: "#bbb" }}>(empty)</span>}
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

function downloadMarkdown(groups: Group[], explanation: string, meta: Meta | null, origin: string) {
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
  for (const g of types) parts.push(groupToMarkdown(g));
  if (others.length) {
    parts.push(`## Other categories`);
    for (const g of others) parts.push(groupToMarkdown(g));
  }
  downloadBlob(`canon-${filenameSafe(title)}.md`, "text/markdown;charset=utf-8", parts.join("\n"));
}

function groupToMarkdown(g: Group): string {
  const lines: string[] = [];
  lines.push(`### ${g.category}${g.template ? ` — \`${g.template}\`` : ""} (${g.pages.length}/${g.totalMembers})`);
  for (const p of g.pages) {
    lines.push(`#### [${p.title}](${p.url})`);
    if (p.fields.length) {
      for (const [k, v] of p.fields) {
        lines.push(`- **${k}:** ${v || "_(empty)_"}`);
      }
    }
    if (p.lead.trim()) {
      lines.push("");
      lines.push(p.lead);
    }
    for (const s of p.sections) {
      const prefix = "#".repeat(Math.min(Math.max(s.level + 2, 3), 6));
      lines.push("");
      lines.push(`${prefix} ${s.heading}`);
      lines.push(s.text);
    }
    lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

function downloadHtml(groups: Group[], explanation: string, meta: Meta | null, origin: string) {
  const title = meta?.sitename || origin;
  const expl = markdownToHtml(explanation || "");
  const types = groups.filter((g) => g.isType);
  const others = groups.filter((g) => g.isType === false);

  const groupHtml = (g: Group) => {
    const pages = g.pages.map((p) => {
      const fields = p.fields.length
        ? "<dl>" + p.fields.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v || "")}</dd>`).join("") + "</dl>"
        : "";
      const lead = p.lead.trim() ? `<p>${escHtml(p.lead).replace(/\n/g, "<br>")}</p>` : "";
      const sections = p.sections.map((s) => {
        const lvl = Math.min(Math.max(s.level + 1, 4), 6);
        return `<h${lvl}>${escHtml(s.heading)}</h${lvl}><p>${escHtml(s.text).replace(/\n/g, "<br>")}</p>`;
      }).join("");
      return `<article><h4><a href="${escHtml(p.url)}">${escHtml(p.title)}</a></h4>${fields}${lead}${sections}</article>`;
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

  downloadBlob(`canon-${filenameSafe(title)}.html`, "text/html;charset=utf-8", html);
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
  return escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
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
