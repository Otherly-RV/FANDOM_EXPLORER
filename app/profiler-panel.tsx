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
// Webmap: interactive hypertext tree. Starts from the Main Page, lazily
// fetches each node's outbound wiki-links via /api/profile/links and lets the
// user walk the actual link graph of the wiki.
// ---------------------------------------------------------------------------

type WebmapLinks = { title: string; sections: Record<string, string[]> };

function WebmapView({
  origin,
  startTitle,
}: {
  origin: string;
  startTitle: string;
}) {
  const [root, setRoot] = useState<string>(startTitle);
  const [input, setInput] = useState<string>(startTitle);

  useEffect(() => {
    setRoot(startTitle);
    setInput(startTitle);
  }, [startTitle]);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) setRoot(input.trim());
          }}
          placeholder="Any page title on this wiki"
          style={{
            flex: 1,
            fontSize: 12,
            padding: "4px 8px",
            border: "1px solid #d4d7e0",
            borderRadius: 6,
          }}
        />
        <button
          className="tbtn primary"
          onClick={() => input.trim() && setRoot(input.trim())}
        >
          Go
        </button>
        <button
          className="tbtn"
          onClick={() => {
            setInput(startTitle);
            setRoot(startTitle);
          }}
          title="Back to Main Page"
        >
          Home
        </button>
      </div>
      <div className="tlabel" style={{ marginBottom: 6 }}>
        Click ▶ to expand a page and see its outbound links. Links are grouped
        by the section heading they appear under.
      </div>
      <WebmapNode key={root} origin={origin} title={root} level={0} defaultOpen />
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
