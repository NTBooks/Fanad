// The manual, readable by the model: site/manual.html (the human-facing book) parsed into plain-text
// sections so "/manual <question>" can ground an answer in EXACTLY what the book says — the manual is the
// single source of truth, not a second copy to drift. Regex parsing is fine here because the file is ours
// (authored in this repo, stable h2/h3 skeleton); no HTML library dependency for one controlled document.
// The whole book is ~48K chars — too big for small local-model contexts — so relevantExcerpt() keyword-scores
// the sections against the question and packs the best ones under a char budget (one LLM call, context-safe;
// same spirit as the listing ranker's cheap context-fit relevance).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', rarr: '→', larr: '←',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', deg: '°', copy: '©',
};
function toText(html) {
  const s = String(html)
    .replace(/<[^>]+>/g, ' ')                                             // tags first…
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))       // …then entities, so &lt; can't become a tag
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? ' ');
  return s.replace(/\s+/g, ' ').trim();
}

let cache; // undefined = not loaded yet · null = no manual in this install · [] never cached
export function resetManualCache() { cache = undefined; } // tests point config elsewhere per-process; this is for unit tests on parsing

// [{ title, text }] in book order — one section per h2/h3 — or null when site/manual.html isn't bundled
// (the docsDir mount in index.js is optional for the same reason). Loaded once and cached: the manual
// ships with the app, so a change means a redeploy/restart anyway.
export function manualSections() {
  if (cache !== undefined) return cache;
  const file = join(config.root, 'site', 'manual.html');
  if (!existsSync(file)) { cache = null; return cache; }
  const html = readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const sections = [];
  for (const part of html.split(/(?=<h[23][\s>])/i).slice(1)) { // lookahead split: each part opens with its heading
    const m = /^<h([23])[^>]*>([\s\S]*?)<\/h\1>/i.exec(part);
    if (!m) continue;
    const title = toText(m[2]);
    const text = toText(part.slice(m[0].length));
    if (!title || !text || /^on this page$/i.test(title)) continue; // skip the TOC block
    sections.push({ title, text });
  }
  cache = sections.length ? sections : null;
  return cache;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'my', 'me', 'it', 'is', 'are', 'do', 'does',
  'did', 'how', 'what', 'when', 'where', 'why', 'who', 'which', 'can', 'could', 'should', 'would', 'you',
  'your', 'with', 'at', 'be', 'this', 'that', 'by', 'from', 'if', 'will', 'was', 'get', 'use', 'there',
  'fanad', 'i',
]);
const words = (q) => (String(q).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));

// The best-matching sections for a question, packed as one "## Title\n…" plain-text excerpt under
// budgetChars. Title hits count 3×; body occurrences 1× each (capped, so one chanty section can't drown
// the rest). Nothing matched → the leading (Quickstart) sections go instead, and the prompt's refusal rule
// does the honest thing. Returns null when the manual isn't bundled.
export function relevantExcerpt(question, budgetChars = 16000) {
  const sections = manualSections();
  if (!sections) return null;
  const qw = words(question);
  const scored = sections.map((s, i) => {
    const title = s.title.toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    for (const w of qw) {
      if (title.includes(w)) score += 3;
      let n = 0;
      for (let at = body.indexOf(w); at !== -1 && n < 5; at = body.indexOf(w, at + w.length)) n++;
      score += n;
    }
    return { ...s, score, i };
  });
  let pick = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (!pick.length) pick = scored.slice(0, 6);
  const out = [];
  let used = 0;
  for (const s of pick) {
    const block = `## ${s.title}\n${s.text}`;
    if (used + block.length > budgetChars) {
      if (!out.length) out.push(block.slice(0, budgetChars)); // a lone oversized section still answers, truncated
      break;
    }
    out.push(block);
    used += block.length + 2;
  }
  return out.join('\n\n');
}
