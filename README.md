# Fandom Explorer

Crawl, visualize and snapshot the **real structure** of any Fandom (MediaWiki) wiki — pages, hyperlinks, categories, sections, infoboxes — as a force-directed graph and an explorable tree.

Deployed as a Next.js app on **Vercel**, with **Neon Postgres** for persistence.

---

## Why "real structure"

The scope of this app is to **replicate** the structure of the source wiki, not invent a new one.

- **Outgoing links** come from the MediaWiki API (`action=parse&prop=links`, namespace 0 only). No LLM is asked "what does this page link to".
- **Categories** come from `prop=categories`. These are the categories the wiki editors actually assigned.
- **Sections** come from `prop=sections` (the real Table of Contents).
- **Infoboxes** are parsed from `.portable-infobox` in the rendered HTML.
- **Summary** is the real first `<p>` of the article. Optionally rewritten for readability by Claude — but never invented. If `CLAUDE_API_KEY` is missing, the raw wiki paragraph is used.

No categories, links, or sections are fabricated.

---

## Architecture

```
Browser (React)  ──►  /api/crawl?url=...    ──►  <wiki>.fandom.com/api.php  (MediaWiki)
                                                 │
                                                 └── optional: Claude (summary only, server-side)
                 ──►  /api/projects          ──►  Neon Postgres  (private, server-side only)
```

### Storage choice: Neon Postgres over Vercel Blob

| Need                                 | Neon | Blob |
| ------------------------------------ | ---- | ---- |
| Relational graph (nodes/edges/links) | ✅    | ❌    |
| Query by URL / resume crawl          | ✅    | ❌    |
| Incremental writes during live crawl | ✅    | ❌    |
| Serverless-friendly                  | ✅    | ✅    |

Blob would force re-serializing and re-uploading the entire snapshot on every change. Neon supports streaming inserts as the crawl progresses and real queries later (find pages in category X, shortest path between two nodes, etc.).

### Privacy: private by default

- `DATABASE_URL` and `CLAUDE_API_KEY` are **server-side only** (not `NEXT_PUBLIC_*`). They never reach the browser.
- Neon connection uses SSL; the schema has no public/anon access.
- All DB access is behind `/api/*` routes on your Vercel origin.
- The `projects.owner` column is reserved so you can bolt on Vercel / Clerk / NextAuth later and scope projects per user. Until auth is added, keep the deployment behind Vercel Password Protection (Pro) or a middleware token if it's not meant to be open.

---

## Setup

### 1. Create a Neon database

1. [neon.tech](https://neon.tech) → new project
2. Copy the pooled connection string
3. Run the schema:

```bash
DATABASE_URL="postgres://..." npm run db:init
```

### 2. Local dev

```bash
npm install
cp .env.example .env.local
# edit .env.local
npm run dev
```

### 3. Deploy to Vercel

```bash
vercel link
vercel env add DATABASE_URL          # paste Neon URL (Production + Preview)
vercel env add CLAUDE_API_KEY        # optional
vercel env add USE_CLAUDE_SUMMARIES  # "1" to enable, else leave unset
vercel deploy --prod
```

Neon has an official Vercel integration that auto-provisions `DATABASE_URL`.

---

## Environment variables

| Name              | Required | Scope   | Purpose                                                   |
| ----------------- | -------- | ------- | --------------------------------------------------------- |
| `DATABASE_URL`    | yes      | server  | Neon Postgres connection string                           |
| `CLAUDE_API_KEY`  | no       | server  | Enables Claude in the AI-provider dropdown                |
| `CLAUDE_MODEL`    | no       | server  | Default `claude-sonnet-4-6`                               |
| `GEMINI_API_KEY`  | no       | server  | Enables Gemini in the AI-provider dropdown                |
| `GEMINI_MODEL`    | no       | server  | Default `gemini-3.1-pro`                                  |

The UI auto-hides providers whose key is missing. If no key is set, the app still works — it just returns the raw first paragraph from the wiki.

---

## Usage

1. Paste a Fandom URL (e.g. `https://harrypotter.fandom.com/wiki/Harry_Potter`)
2. Set max pages (0 = unlimited; be kind to Fandom)
3. Click **Crawl** — watch the network build in real time
4. Click any node to jump to its card; each card shows the real summary, **real categories**, real sections, infobox and outgoing links
5. **💾 Save** stores the snapshot in Neon; **📁 Projects** lists/loads/deletes them

---

## Schema

See [`lib/schema.sql`](lib/schema.sql).
