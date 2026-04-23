// lib/wiki-extract.ts
// Verbatim extraction of a MediaWiki page's infobox + prose.
// No paraphrasing, no rewording — just markup cleanup.

import { mwGet } from "./mw";

export type Section = { heading: string; level: number; text: string };

export type PageContent = {
  template?: string;
  fields: [string, string][];
  lead: string;
  sections: Section[];
};

export async function fetchPageContent(origin: string, title: string): Promise<PageContent | null> {
  const j = await mwGet<any>(origin, {
    action: "parse",
    page: title,
    prop: "wikitext",
    redirects: 1,
  }).catch(() => null);
  if (!j?.parse) return null;
  const wikitext: string = j.parse.wikitext?.["*"] || j.parse.wikitext || "";
  return extractPage(wikitext);
}

export function extractPage(wikitext: string): PageContent {
  if (!wikitext) return { fields: [], lead: "", sections: [] };

  let template: string | undefined;
  let fields: [string, string][] = [];
  let stripped = wikitext;

  const startRe = /\{\{\s*([^|{}\n]*\binfobox\b[^|{}\n]*)/i;
  const startMatch = startRe.exec(wikitext);
  if (startMatch) {
    template = startMatch[1].trim();
    let i = startMatch.index;
    let depth = 0;
    let end = -1;
    for (; i < wikitext.length; i++) {
      if (wikitext[i] === "{" && wikitext[i + 1] === "{") { depth++; i++; }
      else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
        depth--; i++;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end > 0) {
      const body = wikitext.slice(startMatch.index, end);
      const parts = splitTopLevelPipes(body).slice(1);
      const seen = new Set<string>();
      for (const p of parts) {
        const eq = p.indexOf("=");
        if (eq < 0) continue;
        const k = p.slice(0, eq).trim();
        if (!k || k.length > 40 || /[\n{}]/.test(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        const v = cleanValue(p.slice(eq + 1));
        fields.push([k, v]);
        if (fields.length >= 80) break;
      }
      stripped = wikitext.slice(0, startMatch.index) + wikitext.slice(end);
    }
  }

  const headingRe = /^(={2,4})\s*(.+?)\s*\1\s*$/gm;
  const blocks: { heading: string; level: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  blocks.push({ heading: "__LEAD__", level: 0, start: 0, end: stripped.length });
  while ((m = headingRe.exec(stripped))) {
    blocks[blocks.length - 1].end = m.index;
    blocks.push({
      heading: m[2].trim(),
      level: m[1].length,
      start: m.index + m[0].length,
      end: stripped.length,
    });
  }

  let lead = "";
  const sections: Section[] = [];
  const SKIP_HEADINGS = /^(references|external links?|see also|gallery|notes|appearances?|navigation|sources?)$/i;
  for (const b of blocks) {
    const raw = stripped.slice(b.start, b.end);
    const text = cleanProse(raw);
    if (!text) continue;
    if (b.heading === "__LEAD__") { lead = text; continue; }
    if (SKIP_HEADINGS.test(b.heading)) continue;
    sections.push({ heading: b.heading, level: b.level, text });
    if (sections.length >= 50) break;
  }

  return { template, fields, lead, sections };
}

function splitTopLevelPipes(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let link = 0, tmpl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (c === "[" && c2 === "[") { link++; buf += "[["; i++; continue; }
    if (c === "]" && c2 === "]") { link--; buf += "]]"; i++; continue; }
    if (c === "{" && c2 === "{") { tmpl++; buf += "{{"; i++; continue; }
    if (c === "}" && c2 === "}") { tmpl--; buf += "}}"; i++; continue; }
    if (c === "|" && link === 0 && tmpl === 1) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

function cleanValue(raw: string): string {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<ref[^>]*\/\s*>/gi, "");
  s = s.replace(/\[\[([^\]\|]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  s = s.replace(/\{\{[^{}]*\}\}/g, (m) => {
    const inner = m.slice(2, -2);
    const bits = inner.split("|");
    return bits.length > 1 ? bits[bits.length - 1] : "";
  });
  s = s.replace(/<br\s*\/?>/gi, " · ");
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 600) s = s.slice(0, 600) + "…";
  return s;
}

function cleanProse(raw: string): string {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/<ref[^>]*\/\s*>/gi, "");
  s = stripTemplates(s);
  s = s.replace(/\{\|[\s\S]*?\|\}/g, "");
  s = s.replace(/\[\[(?:File|Image):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, "");
  s = s.replace(/\[\[Category:[^\]]+\]\]/gi, "");
  s = s.replace(/\[\[([^\]\|]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1");
  s = s.replace(/\[https?:\/\/\S+\]/g, "");
  s = s.replace(/'{2,5}/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?[a-z][^>]*>/gi, "");
  const lines = s.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (!l) { blank++; if (blank <= 1 && out.length) out.push(""); continue; }
    blank = 0;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  let result = out.join("\n");
  if (result.length > 12000) result = result.slice(0, 12000) + "…";
  return result;
}

function stripTemplates(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "{" && s[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "{" && s[j + 1] === "{") { depth++; j += 2; }
        else if (s[j] === "}" && s[j + 1] === "}") { depth--; j += 2; }
        else j++;
      }
      if (depth !== 0) { out += s[i]; i++; continue; }
      const inner = s.slice(i + 2, j - 2);
      const cleanedInner = stripTemplates(inner);
      const parts = splitTopLevelPipesFlat(cleanedInner);
      const name = (parts[0] || "").trim().toLowerCase();
      if (/^(quote|cquote|bquote|blockquote)\b/.test(name)) {
        const positional = parts.slice(1).filter((p) => !/^[\w\- ]+=/.test(p));
        out += positional[0] ? positional[0].trim() : "";
      }
      i = j;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function splitTopLevelPipesFlat(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let link = 0, tmpl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (c === "[" && c2 === "[") { link++; buf += "[["; i++; continue; }
    if (c === "]" && c2 === "]") { link--; buf += "]]"; i++; continue; }
    if (c === "{" && c2 === "{") { tmpl++; buf += "{{"; i++; continue; }
    if (c === "}" && c2 === "}") { tmpl--; buf += "}}"; i++; continue; }
    if (c === "|" && link === 0 && tmpl === 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}
