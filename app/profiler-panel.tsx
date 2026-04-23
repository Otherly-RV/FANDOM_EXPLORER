"use client";
// app/profiler-panel.tsx
// Second view: canon profiler output for a whole Fandom wiki.
// Uses the /api/profile/* endpoints built in CANON_PROFILER_V1.
import { useCallback, useEffect, useRef, useState } from "react";

type CanonPolicy = {
  mode: "category-split" | "separate-wiki" | "infobox-field" | "none";
  canonCategory?: string;
  nonCanonCategory?: string;
  infoboxField?: string;
  notes?: string[];
  candidateCategories?: string[];
  policyPages?: string[];
};

type Profile = {
  origin: string;
  sitename: string | null;
  lang: string | null;
  mainpage: string | null;
  canon_policy: CanonPolicy;
  root_cats: string[];
  profiled_at: string;
  stale_after: string;
};

type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  phase: string | null;
  pages_seen: number;
  categories_seen: number;
  hubs_seen: number;
  pct: number;
  error: string | null;
  updated_at: string;
  heartbeat_age_s?: number | null;
  revived?: boolean;
};

type Hubs = { hubs: Record<string, Record<string, string[]>>; count: number };

type TreeNode = { name: string; pageCount: number; children: TreeNode[] };

type ClassifyRecord = {
  title: string;
  canonStatus: "canon" | "legends" | "ambiguous" | "unknown";
  type: string | null;
  era: string[];
  media: string[];
  hubs: string[];
  categories: string[];
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

function titleToUrl(origin: string, title: string): string {
  return `${origin}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export default function ProfilerPanel({ urlIn }: { urlIn: string }) {
  const origin = deriveOrigin(urlIn);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [hubs, setHubs] = useState<Hubs | null>(null);
  const [hubsLoading, setHubsLoading] = useState(false);
  const [treeRoot, setTreeRoot] = useState<string>("");
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [classify, setClassify] = useState<ClassifyRecord | null>(null);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const pollRef = useRef<any>(null);

  // Load any cached profile when origin changes.
  const loadProfile = useCallback(async () => {
    if (!origin) return;
    setErr("");
    try {
      const r = await fetch(`/api/profile?origin=${encodeURIComponent(origin)}`);
      const text = await r.text();
      let j: any = {};
      try { j = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
      if (r.ok) {
        setProfile(j.profile);
        setJob(null);
      } else if (r.status === 404) {
        setProfile(null);
        if (j.needsMigrate) setErr("Database not migrated yet. Run /api/admin/migrate?token=… once.");
      } else {
        setProfile(null);
        if (j.needsMigrate) setErr("Database not migrated yet. Run /api/admin/migrate?token=… once.");
        else setErr(j.error || `HTTP ${r.status}`);
      }
    } catch (e: any) {
      setErr(e.message || "failed");
    }
  }, [origin]);

  useEffect(() => {
    loadProfile();
    setHubs(null);
    setTree(null);
    setClassify(null);
  }, [loadProfile]);

  // Auto-load tree + hubs when a profile becomes available.
  useEffect(() => {
    if (!profile) return;
    if (!tree && profile.root_cats.length) {
      // Prefer a root that isn't the generic "Browse" or "Articles" if a
      // better one exists; otherwise fall back to the first.
      const preferred =
        profile.root_cats.find(
          (r) => !/^(browse|articles|contents|content)$/i.test(r)
        ) || profile.root_cats[0];
      loadTree(preferred);
    }
    if (!hubs) loadHubs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // Polling for an in-progress job.
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
            // keep job in state so error is visible
          }
        } catch {
          /* ignore transient */
        }
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
          pages_seen: 0,
          categories_seen: 0,
          hubs_seen: 0,
          pct: 0,
          error: null,
          updated_at: new Date().toISOString(),
        });
        startPolling(j.jobId);
      }
    } catch (e: any) {
      setErr(e.message || "failed");
    }
  }

  async function loadHubs() {
    if (!origin) return;
    setHubsLoading(true);
    try {
      const r = await fetch(`/api/profile/hubs?origin=${encodeURIComponent(origin)}`);
      const j = await safeJson(r);
      if (r.ok) setHubs(j);
      else setErr(j.error || `HTTP ${r.status}`);
    } catch (e: any) {
      setErr(e.message || "failed");
    } finally {
      setHubsLoading(false);
    }
  }

  async function loadTree(root: string) {
    if (!origin || !root) return;
    setTreeLoading(true);
    setTreeRoot(root);
    try {
      const r = await fetch(
        `/api/profile/tree?origin=${encodeURIComponent(origin)}&root=${encodeURIComponent(root)}&depth=4`
      );
      const j = await safeJson(r);
      if (r.ok) setTree(j.tree);
      else setErr(j.error || `HTTP ${r.status}`);
    } catch (e: any) {
      setErr(e.message || "failed");
    } finally {
      setTreeLoading(false);
    }
  }

  async function classifyCurrent() {
    if (!origin) return;
    // Extract title from the current URL input.
    let title = "";
    try {
      const u = new URL(urlIn);
      const m = u.pathname.match(/\/wiki\/(.+)$/);
      if (m) title = decodeURIComponent(m[1]).replace(/_/g, " ");
    } catch {
      /* ignore */
    }
    if (!title) {
      setErr("No page title in URL to classify");
      return;
    }
    setClassifyLoading(true);
    try {
      const r = await fetch(
        `/api/profile/classify?origin=${encodeURIComponent(origin)}&title=${encodeURIComponent(title)}`
      );
      const j = await safeJson(r);
      if (r.ok) setClassify(j.record);
      else setErr(j.error || `HTTP ${r.status}`);
    } catch (e: any) {
      setErr(e.message || "failed");
    } finally {
      setClassifyLoading(false);
    }
  }

  async function kickWorker() {
    if (!job) return;
    setErr("");
    try {
      const r = await fetch(`/api/profile/run?jobId=${job.id}`, { method: "POST" });
      if (!r.ok) {
        const t = await r.text();
        setErr(`kick failed: HTTP ${r.status} ${t.slice(0, 200)}`);
      }
    } catch (e: any) {
      setErr("kick failed: " + (e?.message || e));
    }
  }

  const running = job && (job.status === "queued" || job.status === "running");
  const failed = job && job.status === "error";

  if (!origin) {
    return (
      <div style={{ padding: 16, color: "#888" }}>
        Enter a Fandom URL in the top bar to profile that wiki.
      </div>
    );
  }

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
          <>
            <button
              className="tbtn primary"
              onClick={() => startProfile(false)}
              disabled={!!running}
            >
              {profile ? "Re-check" : "Profile wiki"}
            </button>
            {profile && (
              <button
                className="tbtn"
                onClick={() => startProfile(true)}
                title="Re-run profiler, ignore cache"
              >
                Force refresh
              </button>
            )}
          </>
        )}
      </div>

      {/* Job progress */}
      {running && job && (
        <div
          style={{
            border: "1px solid #e2e4ec",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            background: "#fafafc",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span className="spin" />
            <b>{job.phase || job.status}</b>
            <span className="tlabel">
              · {job.pages_seen} pages · {job.categories_seen} cats · {job.hubs_seen} hub links
            </span>
            <span className="tlabel" style={{ marginLeft: "auto" }}>
              {typeof job.heartbeat_age_s === "number"
                ? `last update ${job.heartbeat_age_s}s ago`
                : ""}
              {job.revived ? " · worker re-kicked" : ""}
            </span>
            <button
              className="tbtn"
              onClick={kickWorker}
              style={{ marginLeft: 6 }}
              title="Force-kick the background worker"
            >
              Kick
            </button>
          </div>
          <div
            style={{
              height: 4,
              background: "#eceef4",
              borderRadius: 2,
              marginTop: 6,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${job.pct}%`,
                height: "100%",
                background: "linear-gradient(90deg,#5c54e8,#2bbfbf)",
                transition: "width .4s",
              }}
            />
          </div>
        </div>
      )}

      {/* Job failure */}
      {failed && job && (
        <div
          style={{
            border: "1px solid #e07a38",
            background: "#fbeee2",
            color: "#a04a18",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          <b>Profile job failed</b>
          <div style={{ marginTop: 4, fontFamily: "monospace", fontSize: 11 }}>
            {job.error || "(no error message)"}
          </div>
          <div className="tlabel" style={{ marginTop: 4 }}>
            phase: {job.phase || "?"} · pages: {job.pages_seen} · cats: {job.categories_seen}
          </div>
        </div>
      )}

      {/* No profile yet */}
      {!profile && !running && !failed && (
        <div
          style={{
            padding: 16,
            border: "1px dashed #d4d7e0",
            borderRadius: 8,
            color: "#555",
            fontSize: 12,
          }}
        >
          This wiki has not been profiled yet. Click <b>Profile wiki</b> to detect its canon
          policy, crawl its category tree, and extract its editorial hubs. The profile is
          cached in Neon and survives across sessions.
        </div>
      )}

      {/* Profile output */}
      {profile && (
        <>
          {/* Canon policy */}
          <Section title="Canon policy">
            <PolicyView policy={profile.canon_policy} />
          </Section>

          {/* Classify current page */}
          <Section title="Classify current page">
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <button
                className="tbtn"
                onClick={classifyCurrent}
                disabled={classifyLoading}
              >
                {classifyLoading ? "…" : "Classify page from top bar"}
              </button>
              <span className="tlabel">uses the URL in the top bar</span>
            </div>
            {classify && <ClassifyView rec={classify} />}
          </Section>

          {/* Editorial hubs */}
          <Section title="Editorial hubs (how the wiki presents itself)">
            {!hubs && (
              <button className="tbtn" onClick={loadHubs} disabled={hubsLoading}>
                {hubsLoading ? "Loading…" : "Load hubs"}
              </button>
            )}
            {hubs && <HubsView origin={origin} hubs={hubs.hubs} />}
          </Section>

          {/* Category tree */}
          <Section title="Category DAG (pick a root)">
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 8,
              }}
            >
              {profile.root_cats.map((r) => (
                <button
                  key={r}
                  className={`tbtn${treeRoot === r ? " active" : ""}`}
                  onClick={() => loadTree(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            {treeLoading && <div className="tlabel">Loading tree…</div>}
            {tree && <TreeView node={tree} origin={origin} />}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#5c54e8",
          textTransform: "uppercase",
          letterSpacing: ".05em",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function PolicyView({ policy }: { policy: CanonPolicy }) {
  const badgeColor = {
    "category-split": "#2d8f50",
    "separate-wiki": "#5c54e8",
    "infobox-field": "#e07a38",
    none: "#999",
  }[policy.mode];
  return (
    <div style={{ fontSize: 12, color: "#333" }}>
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 10,
          background: badgeColor + "22",
          color: badgeColor,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {policy.mode}
      </span>{" "}
      {policy.canonCategory && (
        <span className="cat-tag" style={{ marginLeft: 6 }}>
          canon: {policy.canonCategory}
        </span>
      )}
      {policy.nonCanonCategory && (
        <span className="cat-tag" style={{ marginLeft: 6 }}>
          non-canon: {policy.nonCanonCategory}
        </span>
      )}
      {policy.notes && policy.notes.length > 0 && (
        <ul style={{ paddingLeft: 18, margin: "6px 0", fontSize: 11, color: "#666" }}>
          {policy.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {policy.policyPages && policy.policyPages.length > 0 && (
        <div style={{ fontSize: 10, color: "#888", marginTop: 4 }}>
          Policy pages: {policy.policyPages.join(", ")}
        </div>
      )}
    </div>
  );
}

function ClassifyView({ rec }: { rec: ClassifyRecord }) {
  const statusColor = {
    canon: "#2d8f50",
    legends: "#e07a38",
    ambiguous: "#d9507a",
    unknown: "#888",
  }[rec.canonStatus];
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ marginBottom: 4 }}>
        <b>{rec.title}</b>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 10,
            background: statusColor + "22",
            color: statusColor,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {rec.canonStatus}
        </span>
        {rec.type && <span className="cat-tag">{rec.type}</span>}
        {rec.era.map((e) => (
          <span key={e} className="cat-tag">{e}</span>
        ))}
        {rec.media.map((m) => (
          <span key={m} className="link-tag">{m}</span>
        ))}
      </div>
      {rec.hubs.length > 0 && (
        <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>
          Appears in hubs: {rec.hubs.join(" · ")}
        </div>
      )}
    </div>
  );
}

function HubsView({
  origin,
  hubs,
}: {
  origin: string;
  hubs: Record<string, Record<string, string[]>>;
}) {
  const sources = Object.keys(hubs);
  if (sources.length === 0)
    return <div className="tlabel">No hubs collected.</div>;
  return (
    <div>
      {sources.map((src) => (
        <div key={src} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: "#5c54e8", fontWeight: 600, marginBottom: 4 }}>
            {src}
          </div>
          {Object.entries(hubs[src]).map(([section, links]) => (
            <div key={section} style={{ marginBottom: 4 }}>
              {section && (
                <div style={{ fontSize: 10, color: "#888", margin: "4px 0 2px" }}>
                  {section}
                </div>
              )}
              <div className="link-tags">
                {links.slice(0, 40).map((t) => (
                  <a
                    key={t}
                    className="link-tag"
                    href={titleToUrl(origin, t)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    {t}
                  </a>
                ))}
                {links.length > 40 && (
                  <span className="tlabel">+{links.length - 40} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function TreeView({ node, origin }: { node: TreeNode; origin: string }) {
  return <TreeItem node={node} origin={origin} level={0} />;
}

function TreeItem({
  node,
  origin,
  level,
}: {
  node: TreeNode;
  origin: string;
  level: number;
}) {
  const [open, setOpen] = useState(level < 1);
  const hasKids = node.children.length > 0;
  return (
    <div style={{ marginLeft: level === 0 ? 0 : 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: hasKids ? "pointer" : "default",
          padding: "2px 0",
        }}
        onClick={() => hasKids && setOpen((v) => !v)}
      >
        <span style={{ fontSize: 10, color: "#aaa", width: 10 }}>
          {hasKids ? (open ? "▼" : "▶") : "·"}
        </span>
        <a
          href={`${origin}/wiki/Category:${encodeURIComponent(node.name.replace(/ /g, "_"))}`}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: "#2a2a3f", textDecoration: "none" }}
          onClick={(e) => e.stopPropagation()}
        >
          {node.name}
        </a>
        {node.pageCount > 0 && (
          <span className="tlabel">· {node.pageCount} pages</span>
        )}
        {hasKids && (
          <span className="tlabel">· {node.children.length} subcats</span>
        )}
      </div>
      {open && hasKids && (
        <div>
          {node.children.map((c) => (
            <TreeItem key={c.name} node={c} origin={origin} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
