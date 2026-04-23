"use client";
// app/canon-panel.tsx
// Two-column "Canon Logic" view. Left: LLM-produced tree of how this IP's
// canon is organized. Right: markdown explanation of the meta-logic.
// Source data is live sitemap + top categories + main-page lead. The LLM
// explains — it does not reorganize.
import { useCallback, useEffect, useState } from "react";

type Provider = "gemini" | "claude";
type CanonNode = { label: string; note?: string; children?: CanonNode[] };
type Analysis = {
  tree: CanonNode[];
  explanation: string;
  provider: Provider;
  model: string;
  meta?: { sitename?: string; mainpage?: string; navCount?: number };
};

const MODEL_OPTIONS: { id: string; provider: Provider; label: string }[] = [
  { id: "gemini-3.1-pro", provider: "gemini", label: "Gemini 3.1 Pro (default)" },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", provider: "claude", label: "Claude Opus 4.7" },
];

function deriveOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

export default function CanonPanel({ urlIn }: { urlIn: string }) {
  const origin = deriveOrigin(urlIn);
  const [modelId, setModelId] = useState<string>("gemini-3.1-pro");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string>("");

  const run = useCallback(async () => {
    if (!origin) return;
    setLoading(true);
    setError("");
    setAnalysis(null);
    try {
      const opt = MODEL_OPTIONS.find((m) => m.id === modelId)!;
      const r = await fetch("/api/canon/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin,
          provider: opt.provider,
          model: opt.id,
        }),
      });
      const text = await r.text();
      let j: any = {};
      try {
        j = text ? JSON.parse(text) : {};
      } catch {
        j = { error: text.slice(0, 400) };
      }
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
      } else {
        setAnalysis(j as Analysis);
      }
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }, [origin, modelId]);

  if (!origin) {
    return (
      <div style={{ padding: 16, color: "#888" }}>
        Enter a Fandom URL in the top bar.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(280px, 42%) 1fr",
        height: "100%",
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* Left: canon tree */}
      <div
        style={{
          borderRight: "1px solid #eceef4",
          overflowY: "auto",
          padding: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, color: "#2a2a3f" }}>
            Canon organization
          </div>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="tbtn"
            style={{ appearance: "auto", fontSize: 11 }}
            disabled={loading}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className="tbtn primary"
            onClick={run}
            disabled={loading}
          >
            {loading ? "Analyzing…" : analysis ? "Re-analyze" : "Analyze"}
          </button>
        </div>
        {error && (
          <div
            style={{
              background: "#fbeee2",
              border: "1px solid #e07a38",
              color: "#a04a18",
              padding: "6px 10px",
              borderRadius: 6,
              marginBottom: 10,
              fontSize: 11,
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        )}
        {!analysis && !loading && !error && (
          <div className="tlabel">
            Uses the wiki&#39;s live sitemap + top categories + main-page lead,
            then asks the chosen model to explain how this IP&#39;s canon is
            organized. Nothing is reorganized — only described.
          </div>
        )}
        {loading && <div className="tlabel">Gathering sitemap and asking {modelId}…</div>}
        {analysis && (
          <div>
            {analysis.tree.length === 0 && (
              <div className="tlabel">No tree returned.</div>
            )}
            {analysis.tree.map((n, i) => (
              <TreeNode key={i} node={n} depth={0} />
            ))}
          </div>
        )}
      </div>

      {/* Right: meta explanation */}
      <div style={{ overflowY: "auto", padding: 16 }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "#2a2a3f",
            marginBottom: 8,
          }}
        >
          How this IP builds its canon
        </div>
        {analysis ? (
          <div>
            <div className="tlabel" style={{ marginBottom: 10 }}>
              {analysis.provider} · {analysis.model}
              {analysis.meta?.sitename ? ` · ${analysis.meta.sitename}` : ""}
            </div>
            <MarkdownBlock text={analysis.explanation} />
          </div>
        ) : (
          <div className="tlabel">
            The explanation will appear here after analysis.
          </div>
        )}
      </div>
    </div>
  );
}

function TreeNode({ node, depth }: { node: CanonNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 6,
          padding: "2px 0",
        }}
      >
        <span
          onClick={() => hasKids && setOpen((v) => !v)}
          style={{
            cursor: hasKids ? "pointer" : "default",
            fontSize: 10,
            color: "#5c54e8",
            width: 12,
            userSelect: "none",
            paddingTop: 2,
          }}
        >
          {hasKids ? (open ? "▼" : "▶") : "·"}
        </span>
        <div>
          <div
            style={{
              fontSize: depth === 0 ? 13 : 12,
              fontWeight: depth === 0 ? 700 : depth === 1 ? 600 : 500,
              color: "#2a2a3f",
              textTransform: depth === 0 ? "uppercase" : "none",
              letterSpacing: depth === 0 ? ".04em" : undefined,
            }}
          >
            {node.label}
          </div>
          {node.note && (
            <div
              style={{
                fontSize: 11,
                color: "#666",
                marginTop: 1,
                lineHeight: 1.35,
              }}
            >
              {node.note}
            </div>
          )}
        </div>
      </div>
      {open && hasKids && (
        <div
          style={{
            borderLeft: "1px solid #eceef4",
            marginLeft: 6,
            paddingLeft: 4,
          }}
        >
          {kids.map((c, i) => (
            <TreeNode key={i} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// Minimal markdown renderer — handles headings, bold, italic, inline code,
// bullet lists, and paragraphs. No external deps.
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

  // Heading
  const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (h) {
    const level = h[1].length;
    const size = [17, 15, 14, 13][level - 1];
    return (
      <div
        key={key}
        style={{
          fontSize: size,
          fontWeight: 700,
          color: "#2a2a3f",
          margin: "14px 0 6px",
        }}
      >
        {renderInline(h[2])}
      </div>
    );
  }

  // Bullet list (all lines start with - or *)
  const lines = trimmed.split(/\n/);
  if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
    return (
      <ul
        key={key}
        style={{
          margin: "6px 0",
          paddingLeft: 20,
        }}
      >
        {lines.map((l, i) => (
          <li key={i} style={{ margin: "2px 0" }}>
            {renderInline(l.replace(/^\s*[-*]\s+/, ""))}
          </li>
        ))}
      </ul>
    );
  }

  // Paragraph
  return (
    <p key={key} style={{ margin: "8px 0" }}>
      {renderInline(trimmed)}
    </p>
  );
}

function renderInline(s: string): React.ReactNode {
  // Handle **bold**, *italic*, `code`, and line breaks.
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = regex.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok === "\n") parts.push(<br key={idx++} />);
    else if (tok.startsWith("**"))
      parts.push(<strong key={idx++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*"))
      parts.push(<em key={idx++}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("`"))
      parts.push(
        <code
          key={idx++}
          style={{
            background: "#f4f5f9",
            padding: "1px 4px",
            borderRadius: 3,
            fontSize: "0.9em",
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
