// app/api/profile/nav/route.ts
// GET ?origin=...
//   -> The wiki's canonical navigation tree, straight from
//      MediaWiki:Wiki-navigation (the top-bar menu editors curate).
//      This is what the user sees in the Fandom top navbar:
//      Explore / <Wiki name> / Crossovers / Community / ...
//
// Wikitext format (arbitrary nesting):
//   *Top-level header
//   **[[Target|Label]]
//   ***[[Nested]]
//
// We return a nested tree; each node has { label, target?, children }.
import { NextRequest, NextResponse } from "next/server";
import { mwGet, parseFandomOrigin } from "@/lib/mw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NavNode = {
  label: string;
  target?: string; // null for pure headers
  children: NavNode[];
};

export async function GET(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

async function handle(req: NextRequest) {
  const originRaw = req.nextUrl.searchParams.get("origin") || "";
  if (!originRaw)
    return NextResponse.json({ error: "origin required" }, { status: 400 });
  let origin: string;
  try {
    origin = originRaw.includes("/wiki/")
      ? parseFandomOrigin(originRaw)
      : new URL(originRaw).origin;
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message || "bad origin" },
      { status: 400 }
    );
  }

  const j = await mwGet<any>(origin, {
    action: "parse",
    page: "MediaWiki:Wiki-navigation",
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  const text: string = j?.parse?.wikitext || "";
  if (!text) {
    return NextResponse.json({
      origin,
      source: "MediaWiki:Wiki-navigation",
      found: false,
      tree: [],
    });
  }

  // Parse indented bullet list into a nested tree.
  const tree = parseNav(text);
  return NextResponse.json({
    origin,
    source: "MediaWiki:Wiki-navigation",
    found: true,
    tree,
  });
}

function parseNav(text: string): NavNode[] {
  const roots: NavNode[] = [];
  // Stack tracks the current parent node at each indent level.
  // stack[level-1] is the parent whose next child goes at depth `level`.
  const stack: NavNode[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("*")) continue;
    const m = line.match(/^(\*+)\s*(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    const content = m[2].trim();
    if (!content) continue;
    const node = toNode(content);

    // Prune stack to current level.
    stack.length = level - 1;

    if (level === 1) {
      roots.push(node);
    } else {
      const parent = stack[level - 2];
      if (parent) parent.children.push(node);
      else roots.push(node); // malformed: treat as root
    }
    stack[level - 1] = node;
  }

  return roots;
}

// Turn a single menu-item content string into a NavNode.
// Fandom's real MediaWiki:Wiki-navigation format (no [[ ]] brackets):
//   *Target|Label
//   *Target                 (label defaults to target)
//   *Category:Foo|Label
//   *Special:Community|Label
//   *http://external|Label   → external link (we keep as-is)
//   *#category-Foo#|Label    → special category shortcut
//   *[[Target|Label]]        → also accepted (legacy/other wikis)
function toNode(content: string): NavNode {
  let s = content.trim();
  // Legacy / other-wikis form with [[ ]].
  const bracketed = s.match(/^\[\[([^\]|]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/);
  if (bracketed) {
    const target = bracketed[1].trim().replace(/_/g, " ");
    const label = (bracketed[2] || target).trim();
    return { label, target, children: [] };
  }
  // Strip #prefix# wrappers (#category-…#, #visited#, #new#, …).
  // The inner value is still the effective target.
  const wrapped = s.match(/^#([^#|]+)#(?:\|(.+))?$/);
  if (wrapped) {
    const inner = wrapped[1].trim();
    const label = (wrapped[2] || inner).trim();
    // #category-Foo# → Category:Foo page.
    const catMatch = inner.match(/^category-(.+)$/i);
    if (catMatch) {
      return {
        label,
        target: `Category:${catMatch[1].replace(/_/g, " ").trim()}`,
        children: [],
      };
    }
    // Other magic shortcuts have no navigable target.
    return { label, children: [] };
  }
  // Plain `Target|Label` or `Target`.
  const pipe = s.indexOf("|");
  let target = (pipe >= 0 ? s.slice(0, pipe) : s).trim();
  const label = (pipe >= 0 ? s.slice(pipe + 1) : s).trim();
  if (!target) return { label: label || "(unnamed)", children: [] };
  // External URL → keep as a non-navigable label with an href hint.
  if (/^https?:\/\//i.test(target)) {
    return { label, target, children: [] };
  }
  // Internal wiki page (any namespace).
  target = target.replace(/_/g, " ");
  return { label: label || target, target, children: [] };
}
