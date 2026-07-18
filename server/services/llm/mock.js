// Mock LLM provider — deterministic, no network. Used for tests and for running Fanad before a real
// model is configured (set LLM_PROVIDER=mock / EMBED_PROVIDER=mock).
export async function llmStatus() {
  return { reachable: true, ok: true, provider: 'mock', model: 'mock' };
}

// Crude keyword classifier that returns the same JSON shape the real classifier expects.
export async function chat({ messages = [] } = {}) {
  // Test hook: a message containing __llm_http_<code>__ makes the provider "fail" with that HTTP status, so a
  // test can exercise a caller's error handling (e.g. "/guess" when the model is out of credits / rate-limited).
  const probe = /__llm_http_(\d{3})__/.exec(messages.map((m) => m.content || '').join(' '));
  if (probe) { const e = new Error(`Mock HTTP ${probe[1]}: simulated provider failure`); e.status = Number(probe[1]); throw e; }

  const text = (messages[messages.length - 1]?.content || '').toLowerCase();
  const has = (...kw) => kw.some((k) => text.includes(k));

  // "/guess" and the grooming "break it down" ask the coach to split ONE task into a few first steps
  // (responseFormat = STEPS_SCHEMA). Echo that {steps:[...]} shape — three generic, task-derived steps (the
  // count lands inside llmDecompose's 2-4 window) — so the checklist flow runs offline + deterministically.
  const sys = (messages.find((m) => m.role === 'system')?.content || '').toLowerCase();
  if (sys.includes('break this one task into')) {
    const subj = (messages[messages.length - 1]?.content || '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'the task';
    return JSON.stringify({ steps: [`Get set up for ${subj}`, `Do the main part of ${subj}`, 'Wrap up and tidy'] });
  }

  // Manual Q&A (features/manual.js): stay strictly closed-world, like the real prompt demands. A question
  // word found in the provided excerpt → a one-liner naming the section it sits in; nothing found → the
  // prompt's own exact fallback line (parsed out of the system text so mock and prompts.js can't drift).
  if (sys.includes('using only the fanad manual excerpt')) {
    const sysRaw = messages.find((m) => m.role === 'system')?.content || '';
    const fallback = /reply exactly: "([^"]+)"/.exec(sysRaw)?.[1] || 'The manual doesn’t cover that.';
    const excerpt = sysRaw.slice(sysRaw.indexOf('MANUAL EXCERPT:'));
    const q = (messages[messages.length - 1]?.content || '').toLowerCase();
    const filler = new Set(['what', 'when', 'where', 'which', 'does', 'this', 'that', 'with', 'have', 'will', 'from', 'your', 'about', 'should', 'could', 'would', 'there', 'mean', 'means']);
    const qWords = (q.match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 4 && !filler.has(w));
    for (const block of excerpt.split(/\n## /).slice(1)) {
      const [title] = block.split('\n', 1);
      const body = block.toLowerCase();
      const hit = qWords.find((w) => body.includes(w));
      if (hit) return `From the manual (${title.trim()}): see “${hit}” there.`;
    }
    return fallback;
  }

  // Diet (diet.js): the density guess for an unknown food — piece-words get a per-piece number, everything
  // else reads as weighed. Fixed numbers (70/piece, 50/oz) so tests can assert exact calorie math.
  if (sys.includes('calorie density')) {
    const piece = /\b(egg|apple|banana|slice|cookie|bar)s?\b/.test(text);
    return JSON.stringify({ unit_type: piece ? 'piece' : 'ounce', cal_per_unit: piece ? 70 : 50 });
  }
  // Diet (diet.js): "save meal" with no stated total — a fixed 100 cal per listed item (one per input
  // line), so meal tests can assert exact totals offline.
  if (sys.includes('total calories for each meal item')) {
    const items = (messages[messages.length - 1]?.content || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return JSON.stringify({ items: items.map((name) => ({ name, calories: 100 })) });
  }
  // Diet eat-line fallback: extract no quantity/calories (the heuristic covers those forms in tests), but
  // scrub volume junk from the NAME like the real prompt instructs — so "olives 1/4 cup" deterministically
  // comes back as the food "olives" with nothing measured (→ the ask-for-weight dialog).
  if (sys.includes('logging something they ate')) {
    const food = (messages[messages.length - 1]?.content || '')
      .replace(/\b\d+(?:\/\d+)?\s*(?:cups?|tbsps?|tsps?|tablespoons?|teaspoons?)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    return JSON.stringify({ food, quantity: 0, unit: '', calories: 0 });
  }

  // Journal passes (journal.js): echo each pass's JSON shape, deterministically derived from the input, so
  // the whole trend-journal feature runs offline. Signals come from a tiny keyword sniff over the entry
  // text (dairy/headache are the manual's own worked example), days/counts are fixed.
  if (sys.includes('one day of a personal tracking journal')) {
    const signals = [];
    if (has('headache')) signals.push({ label: 'headache', kind: 'symptom' });
    if (has('dairy')) signals.push({ label: 'dairy', kind: 'intake' });
    if (has('skipped')) signals.push({ label: 'skipped item', kind: 'skip' });
    return JSON.stringify({ summary: 'A mock summary of the day: the checklist and note were recorded.', signals });
  }
  if (sys.includes('combine the given day (or week) summaries')) {
    const signals = [];
    if (has('headache')) signals.push({ label: 'headache', kind: 'symptom', days: 2 });
    if (has('dairy')) signals.push({ label: 'dairy', kind: 'intake', days: 2 });
    return JSON.stringify({ summary: 'A mock rollup: entries were combined and adherence noted.', signals, notable: signals.length ? 'headache days followed dairy days' : '' });
  }
  if (sys.includes('gentle long-term patterns in a tracking journal')) {
    const thin = !has('headache') && !has('dairy');
    return JSON.stringify({
      message: thin
        ? 'The data is still thin — keep logging and patterns will have something to stand on.'
        : 'One pattern might be worth watching: headaches turned up on days that followed dairy. Tentative, not a diagnosis.',
      hypotheses: thin ? [] : [{ pattern: 'headache follows dairy', support: 'headache on 2 of 2 dairy days', against: '' }],
      watch: thin ? [] : ['dairy', 'headache'],
    });
  }

  // "/whatdo" decision (DECIDE_SYS): the model picks ONE task by id from a numbered shortlist and gives a
  // reason. The mock picks the FIRST listed candidate (they arrive prefilter-ranked), skipping the one the
  // user just declined, and echoes the deadline (if any) as its reason — so /whatdo is genuinely
  // LLM-decided offline/in tests, exercising the real closed-world path deterministically.
  if (sys.includes('single best next task')) {
    const user = messages[messages.length - 1]?.content || '';
    const ids = [...user.matchAll(/#(\d+):/g)].map((m) => Number(m[1]));
    const declined = (/just declined #(\d+)/.exec(user) || [])[1];
    const pickId = ids.find((id) => String(id) !== declined) ?? ids[0];
    const line = new RegExp(`#${pickId}: "([^"]*)"([^\\n]*)`).exec(user);
    const summary = line?.[1] || 'this one';
    const meta = line?.[2] || '';
    const due = /due ([^·\n]+)/.exec(meta);
    const energy = (/\b(low|medium|high) energy\b/.exec(user) || [])[1];
    let reason = 'a good fit for right now';
    if (due) reason = `it's due ${due[1].trim()}`;
    else if (/usually done around now/.test(meta)) reason = 'you usually get these done around now';
    else if (energy) reason = `a good fit for your ${energy} energy`;
    return JSON.stringify({ task_id: pickId, reason, message: `How about “${summary}”? You’ve got this. 🌱` });
  }

  // Order matters (first match wins): work before admin so "email the client about the invoice" stays
  // work; health before social so "call the dentist" reads as health, not a social call.
  let category = 'other';
  if (has('email', 'meeting', 'report', 'client', 'boss', 'standup')) category = 'work';
  else if (has('bill', 'tax', 'invoice', 'bank', 'paperwork', 'form', 'renew', 'account', 'insurance', 'budget')) category = 'admin';
  else if (has('clean', 'dishes', 'laundry', 'garage', 'trash', 'vacuum', 'tidy', 'house', 'yard', 'repair')) category = 'household';
  else if (has('buy', 'grocery', 'groceries', 'store', 'pick up', 'errand', 'pharmacy', 'shop')) category = 'errand';
  else if (has('doctor', 'gym', 'run', 'walk', 'sleep', 'water', 'medic', 'meds', 'appointment', 'dentist', 'workout')) category = 'health';
  else if (has('rest', 'relax', 'meditate', 'journal', 'therapy', 'nap', 'recharge', 'unwind', 'breathe')) category = 'selfcare';
  else if (has('learn', 'study', 'course', 'class', 'practice', 'research', 'language', 'skill', 'lesson')) category = 'enrichment';
  else if (has('call', 'mom', 'dad', 'friend', 'family', 'birthday', 'gift', 'text', 'party', 'visit')) category = 'social';
  else if (has('personal', 'identity')) category = 'personal';
  else if (has('watch', 'game', 'read', 'movie', 'play', 'show', 'hobby', 'hike', 'sport')) category = 'recreation';
  else if (has('fix', 'build', 'diy', 'project', 'sort', 'plan')) category = 'task';

  let effort_level = 'medium';
  if (has('quick', 'trivial', 'tiny', 'just ', 'real quick')) effort_level = 'trivial';
  else if (has('small', 'minor', 'short')) effort_level = 'low';
  else if (has('hour', 'big', 'project', 'deep', 'all day', 'overhaul')) effort_level = 'high';

  // The mock doesn't trim wording or infer fuzzy moods — it echoes the (already cleaned) text as both the
  // summary and the detail, and leaves mood to the deterministic word-list (extractMood). Keeps tests
  // offline + predictable; the real model is what produces a shortened summary and a fuzzy mood.
  const content = (messages[messages.length - 1]?.content || '').trim().replace(/\s+/g, ' ');
  const summary = content.slice(0, 140);
  return JSON.stringify({ category, effort_level, summary, detail: content.slice(0, 600), mood: '' });
}

// Deterministic, text-derived embedding (hashed bag-of-words) so cosine similarity is meaningful
// in tests/dev without a real model: notes sharing words get higher similarity.
export async function embed(input) {
  const text = Array.isArray(input) ? input.join(' ') : String(input || '');
  const DIM = 24;
  const v = new Array(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
