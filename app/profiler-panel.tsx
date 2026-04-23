"use client";
// app/profiler-panel.tsx
// Hypertext webmap view for a Fandom wiki.
// Starts from the Main Page and lazily walks outbound wiki-links.
import { useCallback, useEffect, useRef, useState } from "react";

type Profile = {
  origin: string;
  sitename: string | null;
  mainpage: string | null;
};

type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  phase: string | null;
  pct: number;
  error: string | null;
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
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string>("");

  const pollRef = useRef<any>(null);

  // Try to load a cached profile just for sitename + mainpage.
  const loadProfile = useCallback(async () => {
    if (!origin) return;
    setErr("");
    try {
      const r = await fetch(`/api/profile?origin=${encodeURIComponent(origin)}`);
      const text = await r.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON error */ }
      if (r.ok) {
        setProfile(j.profile);
        setJob(null);
      } else {
        setProfile(null);
      }
    } catch (e: any) {
      setErr(e.message || "failed");
    }
  }, [origin]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const startPolling = useCallback(
    (jobId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/profile/status?jobId=${jobId}`);
          if (!r.ok) return;
          const j = await safeJson(r);
          setJob(j.job);
          if (j.job?.status === "done") {
            clearInterval(pollRef.current);
            pollRef.current = null;
            loadProfile();
          } else if (j.job?.status === "error") {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } catch { /* ignore */ }
      }, 2000);
    },
    [loadProfile]
  );

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  async function startProfile(refresh = false) {
    if (!origin) return;
    setErr("");
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, refresh }),
      });
      const j = await safeJson(r);
      if (!r.ok) {
        setErr(j.error || `HTTP ${r.status}`);
        return;
      }
      if (j.status === "done" && j.profile) {
        setProfile(j.profile);
        setJob(null);
        return;
      }
      if (j.jobId) {
        setJob({
          id: j.jobId,
          status: j.status,
          phase: "queued",
          pct: 0,
          error: null,
        });
        startPolling(j.jobId);
      }
    } catch (e: any) {
      setErr(e.message || "failed");
    }
  }

  const running = job && (job.status === "queued" || job.status === "running");

  if (!origin) {
    return (
      <div style={{ padding: 16, color: "#888" }}>
        Enter a Fandom URL in the top bar to explore the wiki.
      </div>
    );
  }

  // The webmap doesn't actually need the cached profile — it just needs a
  // starting title. Default to "Main Page" if we haven't probed yet.
  const startTitle = profile?.mainpage || "Main Page";

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

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>
          {profile?.sitename || origin}
        </div>
        <div className="tlabel">{origin}</div>
        <div style={{ flex: 1 }} />
        {!running && (
          <button
            className="tbtn"
            onClick={() => startProfile(false)}
            title="Re-probe sitename & main page"
          >
            {profile ? "Re-check" : "Probe wiki"}
          </button>
        )}
        {running && job && (
          <span className="tlabel">
            <span className="spin" /> {job.phase || job.status} · {job.pct}%
          </span>
        )}
      </div>

      <WebmapView origin={origin} startTitle={startTitle} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webmap: the wiki's real navigation tree, straight from
// MediaWiki:Wiki-navigation — the menu editors curate for the top navbar.
// Each link can also be expanded to see its own outbound mainspace links.
// ---------------------------------------------------------------------------

type WebmapLinks = { title: string; sections: Record<string, string[]> };
type NavNode = { label: string; target?: string; children: NavNode[] };

function WebmapView({
  origin,
  startTitle,
}: {
  origin: string;
  startTitle: string;
}) {
  const [nav, setNav] = useState<NavNode[] | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState<string>("");
  const [found, setFound] = useState<boolean>(true);

  const loadNav = useCallback(async () => {
    if (!origin) return;
    setNavLoading(true);
    setNavError("");
    try {
      const r = await fetch(
        `/api/profile/nav?origin=${encodeURIComponent(origin)}`
      );
      const j = await safeJson(r);
      if (!r.ok) {
        setNavError(j.error || `HTTP ${r.status}`);
      } else {
        setNav(j.tree || []);
        setFound(!!j.found);
      }
    } catch (e: any) {
      setNavError(e?.message || "failed");
    } finally {
      setNavLoading(false);
    }
  }, [origin]);

  useEffect(() => {
    loadNav();
  }, [loadNav]);

  return (
    <div>
      <div className="tlabel" style={{ marginBottom: 6 }}>
        Source: <code>MediaWiki:Wiki-navigation</code> — the curated top-navbar
        menu. Click ▶ on any link to see that page's outbound links too.
      </div>

      {navLoading && !nav && <div className="tlabel">Loading nav…</div>}
      {navError && (
        <div className="tlabel" style={{ color: "#a04a18" }}>
          {navError}
        </div>
      )}
      {nav && !found && (
        <div className="tlabel">
          This wiki has no <code>MediaWiki:Wiki-navigation</code> page. Falling
          back to the Main Page below.
        </div>
      )}
      {nav && nav.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {nav.map((n, i) => (
            <NavNodeView key={i} node={n} origin={origin} level={0} />
          ))}
        </div>
      )}

      {/* Always expose the Main Page as a second root so you can walk into
          the body content even when the nav menu is the primary entry. */}
      <div
        style={{
          borderTop: "1px solid #e2e4ec",
          marginTop: 10,
          paddingTop: 8,
        }}
      >
        <div
          className="tlabel"
          style={{ marginBottom: 4, fontWeight: 600, color: "#5c54e8" }}
        >
          Main Page body
        </div>
        <WebmapNode
          key={startTitle}
          origin={origin}
          title={startTitle}
          level={0}
        />
      </div>
    </div>
  );
}

function NavNodeView({
  node,
  origin,
  level,
}: {
  node: NavNode;
  origin: string;
  level: number;
}) {
  const [open, setOpen] = useState(level < 1);
  const hasKids = node.children.length > 0;
  // If this node has a target, we also let the user drill into its outbound
  // links (toggled separately from the nav-children expand).
  const [drillOpen, setDrillOpen] = useState(false);

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
          onClick={() => hasKids && setOpen((v) => !v)}
          style={{
            cursor: hasKids ? "pointer" : "default",
            fontSize: 10,
            color: "#5c54e8",
            width: 12,
            userSelect: "none",
          }}
        >
          {hasKids ? (open ? "▼" : "▶") : "·"}
        </span>
        {node.target ? (
          <a
            href={`${origin}/wiki/${encodeURIComponent(
              node.target.replace(/ /g, "_")
            )}`}
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
        {node.target && node.label !== node.target && (
          <span className="tlabel" style={{ fontSize: 10 }}>
            → {node.target}
          </span>
        )}
        {node.target && (
          <button
            className="tbtn"
            style={{ marginLeft: "auto", fontSize: 10, padding: "1px 6px" }}
            onClick={() => setDrillOpen((v) => !v)}
            title="Show outbound links of this page"
          >
            {drillOpen ? "hide links" : "drill"}
          </button>
        )}
      </div>
      {open && hasKids && (
        <div
          style={{
            borderLeft: "1px solid #eceef4",
            marginLeft: 6,
            paddingLeft: 4,
          }}
        >
          {node.children.map((c, i) => (
            <NavNodeView key={i} node={c} origin={origin} level={level + 1} />
          ))}
        </div>
      )}
      {drillOpen && node.target && (
        <div
          style={{
            borderLeft: "1px dashed #d9cbe8",
            marginLeft: 6,
            paddingLeft: 4,
            marginTop: 2,
          }}
        >
          <WebmapNode
            origin={origin}
            title={node.target}
            level={level + 1}
            defaultOpen
          />
        </div>
      )}
    </div>
  );
}

function WebmapNode({
  origin,
  title,
  level,
  defaultOpen = false,
}: {
  origin: string;
  title: string;
  level: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<WebmapLinks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(
        `/api/profile/links?origin=${encodeURIComponent(
          origin
        )}&title=${encodeURIComponent(title)}&limit=80`
      );
      const j = await safeJson(r);
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
      } else {
        setData({ title: j.title, sections: j.sections || {} });
      }
    } catch (e: any) {
      setError(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }, [origin, title]);

  useEffect(() => {
    if (open && !loadedRef.current) load();
  }, [open, load]);

  const sectionKeys = data ? Object.keys(data.sections) : [];
  const totalLinks = data
    ? sectionKeys.reduce((n, k) => n + data.sections[k].length, 0)
    : 0;

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
          onClick={() => setOpen((v) => !v)}
          style={{
            cursor: "pointer",
            fontSize: 10,
            color: "#5c54e8",
            width: 12,
            userSelect: "none",
          }}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "▼" : "▶"}
        </span>
        <a
          href={`${origin}/wiki/${encodeURIComponent(
            title.replace(/ /g, "_")
          )}`}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 12,
            color: level === 0 ? "#2a2a3f" : "#3a3a55",
            fontWeight: level === 0 ? 600 : 400,
            textDecoration: "none",
          }}
        >
          {title}
        </a>
        {loading && <span className="tlabel">loading…</span>}
        {data && (
          <span className="tlabel">
            · {totalLinks} links
            {sectionKeys.length > 1 ? ` · ${sectionKeys.length} sections` : ""}
          </span>
        )}
        {error && (
          <span className="tlabel" style={{ color: "#a04a18" }}>
            · {error}
          </span>
        )}
      </div>
      {open && data && (
        <div
          style={{
            borderLeft: "1px solid #eceef4",
            marginLeft: 6,
            paddingLeft: 4,
          }}
        >
          {sectionKeys.length === 0 && (
            <div className="tlabel" style={{ marginLeft: 14 }}>
              No outbound links.
            </div>
          )}
          {sectionKeys.map((s) => (
            <div key={s} style={{ marginTop: s ? 6 : 0 }}>
              {s && (
                <div
                  style={{
                    fontSize: 10,
                    color: "#5c54e8",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: ".05em",
                    marginLeft: 14,
                    marginBottom: 2,
                  }}
                >
                  {s}
                </div>
              )}
              {data.sections[s].map((t) => (
                <WebmapNode
                  key={`${s}::${t}`}
                  origin={origin}
                  title={t}
                  level={level + 1}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
