"use client";
// app/profiler-panel.tsx
// Sitemap view: MediaWiki:Wiki-navigation (top menu) + per-page table of
// contents. Nothing else.
import { useCallback, useEffect, useRef, useState } from "react";

type Profile = {
  origin: string;
  sitename: string | null;
  mainpage: string | null;
};

function deriveOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return "";
  }
}

async function safeJson(r: Response): Promise<any> {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export default function ProfilerPanel({ urlIn }: { urlIn: string }) {
  const origin = deriveOrigin(urlIn);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [err, setErr] = useState<string>("");

  const loadProfile = useCallback(async () => {
    if (!origin) return;
    setErr("");
    try {
      const r = await fetch(`/api/profile?origin=${encodeURIComponent(origin)}`);
      const text = await r.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { /* */ }
      if (r.ok) setProfile(j.profile);
      else setProfile(null);
    } catch (e: any) {
      setErr(e.message || "failed");
    }
  }, [origin]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  if (!origin) {
    return (
      <div style={{ padding: 16, color: "#888" }}>
        Enter a Fandom URL in the top bar.
      </div>
    );
  }

  const mainpage = profile?.mainpage || "Main Page";

  return (
    <div style={{ padding: 12, overflowY: "auto", height: "100%" }}>
      {err && (
        <div
          style={{
            background: "#fbeee2",
            border: "1px solid #e07a38",
            color: "#a04a18",
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 10,
            fontSize: 11,
          }}
        >
          {err}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {profile?.sitename || origin}
        </div>
        <div className="tlabel">{origin}</div>
      </div>

      {/* Home page root */}
      <RootNode origin={origin} mainpage={mainpage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root: Home Page label + the curated nav menu underneath it.
// ---------------------------------------------------------------------------

type NavNode = { label: string; target?: string; children: NavNode[] };

function RootNode({
  origin,
  mainpage,
}: {
  origin: string;
  mainpage: string;
}) {
  const [nav, setNav] = useState<NavNode[] | null>(null);
  const [navError, setNavError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/profile/nav?origin=${encodeURIComponent(origin)}`
        );
        const j = await safeJson(r);
        if (cancelled) return;
        if (!r.ok) setNavError(j.error || `HTTP ${r.status}`);
        else setNav(j.tree || []);
      } catch (e: any) {
        if (!cancelled) setNavError(e?.message || "failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin]);

  return (
    <div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#2a2a3f",
          marginBottom: 6,
        }}
      >
        <a
          href={`${origin}/wiki/${encodeURIComponent(
            mainpage.replace(/ /g, "_")
          )}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#2a2a3f", textDecoration: "none" }}
        >
          🏠 {mainpage}
        </a>
      </div>
      {!nav && !navError && <div className="tlabel">Loading sitemap…</div>}
      {navError && (
        <div className="tlabel" style={{ color: "#a04a18" }}>
          {navError}
        </div>
      )}
      {nav && (
        <div>
          {nav.map((n, i) => (
            <MenuNode key={i} node={n} origin={origin} level={0} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu node: either a pure menu header (no target) or a menu link.
//
// Curated children (already in the nav wikitext, free) are ALWAYS rendered.
// The expand/collapse toggle controls only the lazy-loaded page contents:
// the target page's table of contents (for article pages) OR its
// subcategories + member pages (for Category: pages).
// ---------------------------------------------------------------------------

function normalizeTarget(target: string): string {
  // MediaWiki link tricks: a leading ":" forces a regular link to a
  // category/file/etc. Strip it for URL building.
  return target.replace(/^:+/, "");
}

function MenuNode({
  node,
  origin,
  level,
}: {
  node: NavNode;
  origin: string;
  level: number;
}) {
  const hasTarget =
    !!node.target && !/^https?:/i.test(node.target);
  const [open, setOpen] = useState(false);
  const target = node.target ? normalizeTarget(node.target) : "";

  return (
    <div style={{ marginLeft: level === 0 ? 0 : 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 0",
        }}
      >
        <span
          onClick={() => hasTarget && setOpen((v) => !v)}
          title={hasTarget ? (open ? "Hide page contents" : "Show page contents (TOC / category members)") : undefined}
          style={{
            cursor: hasTarget ? "pointer" : "default",
            fontSize: 10,
            color: "#5c54e8",
            width: 12,
            userSelect: "none",
          }}
        >
          {hasTarget ? (open ? "▼" : "▶") : "·"}
        </span>
        {node.target ? (
          <a
            href={
              /^https?:/i.test(node.target)
                ? node.target
                : `${origin}/wiki/${encodeURIComponent(
                    target.replace(/ /g, "_")
                  )}`
            }
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12,
              color: level === 0 ? "#2a2a3f" : "#3a3a55",
              fontWeight: level === 0 ? 600 : 500,
              textDecoration: "none",
            }}
          >
            {node.label}
          </a>
        ) : (
          <span
            style={{
              fontSize: 12,
              color: "#5c54e8",
              fontWeight: 600,
              textTransform: level === 0 ? "uppercase" : "none",
              letterSpacing: level === 0 ? ".05em" : undefined,
            }}
          >
            {node.label}
          </span>
        )}
      </div>
      {/* Editor-curated submenu (free data, always rendered). */}
      {node.children.length > 0 && (
        <div
          style={{
            borderLeft: "1px solid #eceef4",
            marginLeft: 6,
            paddingLeft: 4,
          }}
        >
          {node.children.map((c, i) => (
            <MenuNode key={i} node={c} origin={origin} level={level + 1} />
          ))}
        </div>
      )}
      {/* Lazy: target page's TOC or category members (network fetch). */}
      {open && hasTarget && (
        <div
          style={{
            borderLeft: "1px solid #eceef4",
            marginLeft: 6,
            paddingLeft: 4,
          }}
        >
          <PageContents
            origin={origin}
            title={target}
            level={level + 1}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PageContents: for article pages → table of contents (nested).
//               for Category: pages → subcategories + member pages.
// ---------------------------------------------------------------------------

type TocNode = {
  number: string;
  label: string;
  anchor: string;
  level: number;
  children: TocNode[];
};

function PageContents({
  origin,
  title,
  level,
}: {
  origin: string;
  title: string;
  level: number;
}) {
  const isCategory = /^Category:/i.test(title);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  // For articles:
  const [toc, setToc] = useState<TocNode[] | null>(null);
  // For categories:
  const [subcats, setSubcats] = useState<string[] | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        if (isCategory) {
          const r = await fetch(
            `/api/profile/catmembers?origin=${encodeURIComponent(
              origin
            )}&title=${encodeURIComponent(title)}&limit=500`
          );
          const j = await safeJson(r);
          if (cancelled) return;
          if (!r.ok) setError(j.error || `HTTP ${r.status}`);
          else {
            setSubcats(j.sections?.Subcategories || []);
            setPages(j.sections?.Pages || []);
          }
        } else {
          const r = await fetch(
            `/api/profile/sections?origin=${encodeURIComponent(
              origin
            )}&title=${encodeURIComponent(title)}`
          );
          const j = await safeJson(r);
          if (cancelled) return;
          if (!r.ok) setError(j.error || `HTTP ${r.status}`);
          else setToc(j.tree || []);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, title, isCategory]);

  if (loading) return <div className="tlabel" style={{ marginLeft: 14 }}>Loading…</div>;
  if (error)
    return (
      <div className="tlabel" style={{ marginLeft: 14, color: "#a04a18" }}>
        {error}
      </div>
    );

  if (isCategory) {
    const hasAny = (subcats?.length || 0) + (pages?.length || 0) > 0;
    if (!hasAny)
      return <div className="tlabel" style={{ marginLeft: 14 }}>Empty category.</div>;
    return (
      <div>
        {subcats && subcats.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                fontSize: 10,
                color: "#5c54e8",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".05em",
                marginLeft: 14,
              }}
            >
              Subcategories
            </div>
            {subcats.map((t) => (
              <MenuNode
                key={t}
                node={{ label: t.replace(/^Category:/, ""), target: t, children: [] }}
                origin={origin}
                level={level}
              />
            ))}
          </div>
        )}
        {pages && pages.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                fontSize: 10,
                color: "#5c54e8",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".05em",
                marginLeft: 14,
              }}
            >
              Pages
            </div>
            {pages.map((t) => (
              <MenuNode
                key={t}
                node={{ label: t, target: t, children: [] }}
                origin={origin}
                level={level}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Article: table of contents
  if (!toc || toc.length === 0) {
    return (
      <div className="tlabel" style={{ marginLeft: 14 }}>
        No table of contents.
      </div>
    );
  }
  return (
    <div>
      {toc.map((n, i) => (
        <TocItem
          key={i}
          node={n}
          origin={origin}
          page={title}
          level={level}
        />
      ))}
    </div>
  );
}

function TocItem({
  node,
  origin,
  page,
  level,
}: {
  node: TocNode;
  origin: string;
  page: string;
  level: number;
}) {
  const [open, setOpen] = useState(true);
  const hasKids = node.children.length > 0;
  return (
    <div style={{ marginLeft: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "1px 0",
        }}
      >
        <span
          onClick={() => hasKids && setOpen((v) => !v)}
          style={{
            cursor: hasKids ? "pointer" : "default",
            fontSize: 10,
            color: "#aaa",
            width: 12,
            userSelect: "none",
          }}
        >
          {hasKids ? (open ? "▼" : "▶") : "·"}
        </span>
        <span
          className="tlabel"
          style={{ fontSize: 10, minWidth: 28, color: "#888" }}
        >
          {node.number}
        </span>
        <a
          href={`${origin}/wiki/${encodeURIComponent(
            page.replace(/ /g, "_")
          )}#${encodeURIComponent(node.anchor)}`}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 12,
            color: "#3a3a55",
            textDecoration: "none",
          }}
        >
          {node.label}
        </a>
      </div>
      {open && hasKids && (
        <div>
          {node.children.map((c, i) => (
            <TocItem
              key={i}
              node={c}
              origin={origin}
              page={page}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
