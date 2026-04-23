-- schema.sql — run once against your Neon database.
-- All data is private to the server (no public row-level access).

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_url    TEXT NOT NULL,
  node_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner       TEXT                         -- reserved for future auth
);

CREATE TABLE IF NOT EXISTS pages (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL,
  depth       INTEGER NOT NULL,
  parent_url  TEXT,
  summary     TEXT,
  sections    JSONB NOT NULL DEFAULT '[]'::jsonb,
  categories  JSONB NOT NULL DEFAULT '[]'::jsonb,
  links       JSONB NOT NULL DEFAULT '[]'::jsonb,
  infobox     JSONB,
  key_facts   JSONB,
  ai_provider TEXT,
  ai_model    TEXT,
  error       BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, url)
);

-- Backfill for existing installs
ALTER TABLE pages ADD COLUMN IF NOT EXISTS key_facts   JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS ai_provider TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS ai_model    TEXT;

CREATE TABLE IF NOT EXISTS edges (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  src_url     TEXT NOT NULL,
  dst_url     TEXT NOT NULL,
  PRIMARY KEY (project_id, src_url, dst_url)
);

CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project_id);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);

-- =========================================================================
-- Canon profiler (CANON_PROFILER_V1) — per-wiki cached structure.
-- Profiles are permanent once written; `stale_after` is a staleness hint only.
-- =========================================================================

CREATE TABLE IF NOT EXISTS wiki_profiles (
  origin        TEXT PRIMARY KEY,           -- e.g. https://starwars.fandom.com
  sitename      TEXT,
  lang          TEXT,
  mainpage      TEXT,
  canon_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,
  root_cats     JSONB NOT NULL DEFAULT '[]'::jsonb,
  profiled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale_after   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '8 hours'),
  etag          TEXT
);

CREATE TABLE IF NOT EXISTS wiki_categories (
  origin     TEXT NOT NULL,
  category   TEXT NOT NULL,                 -- child
  parent     TEXT NOT NULL,                 -- parent category ('' for roots)
  depth      INTEGER NOT NULL,
  PRIMARY KEY (origin, category, parent)
);
CREATE INDEX IF NOT EXISTS idx_wiki_categories_origin ON wiki_categories(origin);
CREATE INDEX IF NOT EXISTS idx_wiki_categories_parent ON wiki_categories(origin, parent);

CREATE TABLE IF NOT EXISTS wiki_pages (
  origin        TEXT NOT NULL,
  title         TEXT NOT NULL,
  type          TEXT,                        -- Character / Location / Event / ...
  canon_status  TEXT,                        -- canon | legends | ambiguous | unknown
  era           JSONB NOT NULL DEFAULT '[]'::jsonb,
  media         JSONB NOT NULL DEFAULT '[]'::jsonb,
  hubs          JSONB NOT NULL DEFAULT '[]'::jsonb,
  categories    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origin, title)
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_origin ON wiki_pages(origin);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_canon ON wiki_pages(origin, canon_status);

CREATE TABLE IF NOT EXISTS wiki_hubs (
  origin      TEXT NOT NULL,
  hub_source  TEXT NOT NULL,                 -- e.g. MediaWiki:Wiki-navigation, Main_Page, Portal:Films
  section     TEXT NOT NULL,                 -- heading under which the link appears ('' if top-level)
  link_title  TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (origin, hub_source, section, link_title)
);
CREATE INDEX IF NOT EXISTS idx_wiki_hubs_origin ON wiki_hubs(origin);

CREATE TABLE IF NOT EXISTS profile_jobs (
  id               TEXT PRIMARY KEY,
  origin           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  phase            TEXT,
  pages_seen       INTEGER NOT NULL DEFAULT 0,
  categories_seen  INTEGER NOT NULL DEFAULT 0,
  hubs_seen        INTEGER NOT NULL DEFAULT 0,
  pct              INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  resume_state     JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profile_jobs_origin_status ON profile_jobs(origin, status);

-- Backfill for existing installs
ALTER TABLE profile_jobs ADD COLUMN IF NOT EXISTS resume_state JSONB;
