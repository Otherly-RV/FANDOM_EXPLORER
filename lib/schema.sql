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
-- Drop legacy canon-profiler tables if present (superseded by live sitemap).
-- =========================================================================
DROP TABLE IF EXISTS profile_jobs;
DROP TABLE IF EXISTS wiki_hubs;
DROP TABLE IF EXISTS wiki_pages;
DROP TABLE IF EXISTS wiki_categories;
DROP TABLE IF EXISTS wiki_profiles;
