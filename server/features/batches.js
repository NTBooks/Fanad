// The Batches module (opt-in): process-batch tracking's chat surface — command shapes, the batch card
// with its tap-to-check buttons, the log/close/delete dialogs, and the history view. The engine lives in
// server/batches.js, following the metrics.js split. A batch's directions come from a task_template
// snapshot (the journal rule); each run gets its own #number, dated log, and outcome. Everything here
// answers in the module's own voice: a batch moves only when the user says so — no reminders, ever.
import { getBatchById, listBatchNames, listBatchLog, deleteBatchesByName, listBatches } from '../repo.js';
import {
  resolveOpenBatch, openBatch, toggleBatchItems, checkAllBatchItems, logLine, closeBatch, batchHistory,
  addBatchStep, removeBatchStep, editBatchStep, saveBatchAsVersion, rejectVersion, unrejectVersion,
  batchVersions, familyOf,
} from '../batches.js';
import { parseChecklist } from '../journal.js';
import { setDialogState, clearDialogState, deleteConfirmAnswer } from '../dialog.js';
import { registerFeature } from './registry.js';

const USAGE =
  '🧪 Batches — track each run of a process, and refine the recipe run over run.\n'
  + '• batch new <name> — start a run from your latest saved version (directions come from your /templates)\n'
  + '• batch — show the current run · batch check 1 2 ticks steps · batch log <text> adds a dated line\n'
  + '• batch add/edit/rm — tweak the steps as you go · batch save — graduate them into a new version\n'
  + '• batch done [how it went] — close · batch history/versions <name> · batch reject <name> #<n> — drop a bad version\n'
  + '(“guide batches” walks you through it.)';

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

// ── Rendering ──
function homeReply(userId) {
  const names = listBatchNames(userId);
  if (!names.length) {
    return `${USAGE}\n\nNo batches yet — save a task with steps as a template (“template <task N> sourdough”), then “batch new sourdough” starts run #1.`;
  }
  const lines = names.map((n, i) => {
    const bits = [`${i + 1}. 🧪 ${n.name}`, `${n.total} run${n.total === 1 ? '' : 's'}`];
    if (n.open) bits.push(`${n.open} open`);
    return bits.join(' · ');
  });
  const buttons = names.map((n) => {
    const open = listBatches(userId, n.name).find((b) => b.status === 'open');
    return open
      ? [{ text: `🧪 ${trunc(n.name, 18)} — open #${open.batch_no}`, data: `m:bop:${open.id}` }]
      : [{ text: `🧪 ${trunc(n.name, 18)} — history`, data: `m:bhi:${listBatches(userId, n.name)[0].id}` }];
  });
  return {
    text: `🧪 Your batches:\n${lines.join('\n')}\n(“batch new <name>” starts a run · “batch history <name>” shows past ones)`,
    buttons,
  };
}

function batchCard(userId, batch, { created = false } = {}) {
  const items = parseChecklist(batch.checklist_json);
  const done = items.filter((i) => i.done).length;
  const log = listBatchLog(userId, batch.id, 5);
  const closed = batch.status === 'closed';
  const text = [
    `🧪 ${batch.name} — batch #${batch.batch_no}${created ? ' (fresh)' : ''}${closed ? ` · closed ${shortDate(batch.closed_at)}` : ` · opened ${shortDate(batch.opened_at)}`}`,
    items.length ? `Steps ${done}/${items.length}:\n${items.map((it, i) => `${i + 1}. ${it.done ? '☑' : '☐'} ${it.text}`).join('\n')}` : null,
    log.length ? `📓 Log:\n${log.map((l) => `${shortDate(l.created_at)} — ${l.text}`).join('\n')}` : null,
    closed && batch.outcome ? `🏁 ${batch.outcome}` : null,
    closed ? null : '(“batch check 1 2” ticks steps · “batch log <text>” adds a line · “batch done <how it went>” closes it)',
  ].filter(Boolean).join('\n');
  if (closed) return { text, buttons: [[{ text: '🗂 History', data: `m:bhi:${batch.id}` }]] };
  const buttons = [
    ...items.map((it, i) => [{ text: `${it.done ? '☑' : '☐'} ${i + 1} · ${trunc(it.text, 24)}`, data: `m:bch:${batch.id}.${i + 1}` }]),
    [{ text: '✅ All done', data: `m:bca:${batch.id}` }, { text: '📓 Add log line', data: `m:blg:${batch.id}` }],
    [{ text: '➕ Add step', data: `m:bas:${batch.id}` }, { text: '💾 Save as version', data: `m:bsv:${batch.id}` }],
    [{ text: '🏁 Close batch', data: `m:bdn:${batch.id}` }, { text: '🗂 History', data: `m:bhi:${batch.id}` }],
  ];
  return { text, buttons };
}

// One-line recipe-version lineage, e.g. "🌱 versions: #1 (original) · #2 ✗ · #3 ← latest". Empty → ''.
function lineageLine(userId, base) {
  const vs = batchVersions(userId, base);
  if (vs.length < 1) return '';
  const bits = vs.map((v) => `#${v.n}${v.original ? ' (original)' : ''}${v.rejected ? ' ✗' : ''}${v.latest ? ' ← latest' : ''}`);
  return `🌱 versions: ${bits.join(' · ')}`;
}

function historyReply(userId, name) {
  const base = familyOf(name).base;
  const runs = batchHistory(userId, base);
  if (!runs.length) return `No “${base}” batches yet — “batch new ${base}” starts run #1.`;
  const lines = runs.map((b) => {
    const span = b.status === 'closed' ? `${shortDate(b.opened_at)}→${shortDate(b.closed_at)}` : `opened ${shortDate(b.opened_at)}`;
    const bits = [`#${b.batch_no}`, span, b.total ? `${b.done}/${b.total} steps` : null,
      b.status === 'open' ? 'still open' : (b.outcome ? `🏁 ${b.outcome}` : 'closed')];
    return bits.filter(Boolean).join(' · ');
  });
  const lineage = lineageLine(userId, base);
  return `🗂 ${runs[0].name} — ${runs.length} run${runs.length === 1 ? '' : 's'}:\n${lines.join('\n')}${lineage ? `\n${lineage}` : ''}`;
}

function versionsReply(userId, base) {
  const vs = batchVersions(userId, familyOf(base).base);
  if (!vs.length) return `No “${familyOf(base).base}” template yet — save a task with steps as a template, then “batch new ${familyOf(base).base}”.`;
  const lines = vs.map((v) => {
    const tags = [v.original ? 'original' : null, `${v.steps} step${v.steps === 1 ? '' : 's'}`, v.rejected ? '✗ rejected' : null, v.latest ? '← latest' : null];
    return `#${v.n} — ${tags.filter(Boolean).join(' · ')}`;
  });
  return `🌱 “${vs[0] && familyOf(base).base}” recipe versions:\n${lines.join('\n')}\n(“batch reject ${familyOf(base).base} #<n>” drops one · “batch unreject …” restores it · “batch new <name>” starts from the latest)`;
}

const GONE = { text: 'That batch is gone — bare “batches” lists yours.', buttons: null, toast: 'Already gone' };

// Each run() re-checks the gate itself: an off module answers with the turn-on offer, never silence
// (the metrics pattern). Bare "batch …" forms match even when off — the offer is the discoverability.
const gated = (fn) => (ctx, hit) => (ctx.isOn('batches') ? fn(ctx, hit) : ctx.offerOn('batches'));

registerFeature({
  name: 'batches',
  commands: [
    { match: ({ lower }) => /^\/?batches$/.test(lower),
      run: gated(({ userId }) => homeReply(userId)) },
    { match: ({ t }) => /^\/?batch\s+new\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const out = openBatch(userId, m[1].trim());
        if (out.error) return out.error;
        const from = out.version === out.base ? 'the template' : `version “${out.version}”`;
        const card = batchCard(userId, out.batch, { created: true });
        return { ...card, text: `🧪 Batch #${out.batch.batch_no} of “${out.batch.name}” is open — ${out.steps.length} step${out.steps.length === 1 ? '' : 's'} snapshotted from ${from}.\n\n${card.text}` };
      }) },
    { match: ({ t }) => /^\/?batch\s+(check|uncheck)\s+(\d+(?:[\s,]+\d+)*)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const out = toggleBatchItems(userId, r.batch.id, m[2].split(/[\s,]+/).map(Number), !/^un/i.test(m[1]));
        const missNote = out.missing.length ? `\n(no step ${out.missing.join(', ')} — the checklist has ${out.items.length})` : '';
        const card = batchCard(userId, out.batch);
        return { ...card, text: card.text + missNote };
      }) },
    // ── Step tweaking on the current open run (edit/rm carry inline args, so no dialog). ──
    { match: ({ t }) => /^\/?batch\s+add\s+([\s\S]+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const out = addBatchStep(userId, r.batch.id, m[1].trim());
        if (out.error) return out.error;
        return batchCard(userId, out.batch);
      }) },
    { match: ({ t }) => /^\/?batch\s+edit\s+#?(\d+)\s+([\s\S]+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const out = editBatchStep(userId, r.batch.id, Number(m[1]), m[2].trim());
        if (out.error) return out.error;
        const miss = out.missing?.length ? `\n(no step ${out.missing.join(', ')} — the checklist has ${out.items.length})` : '';
        return { ...batchCard(userId, out.batch), text: batchCard(userId, out.batch).text + miss };
      }) },
    { match: ({ t }) => /^\/?batch\s+(?:rm|remove)\s+(#?\d+(?:[\s,]+#?\d+)*)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const positions = m[1].split(/[\s,]+/).map((s) => Number(s.replace('#', '')));
        const out = removeBatchStep(userId, r.batch.id, positions);
        if (out.error) return out.error;
        const miss = out.missing.length ? `\n(no step ${out.missing.join(', ')} — the checklist has ${out.items.length})` : '';
        const rmNote = out.removed.length ? `🗑 Removed step ${out.removed.join(', ')}.\n` : '';
        return { ...batchCard(userId, out.batch), text: rmNote + batchCard(userId, out.batch).text + miss };
      }) },
    { match: ({ t }) => /^\/?batch\s+save\s*$/i.exec(t),
      run: gated(({ userId }) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const out = saveBatchAsVersion(userId, r.batch.id);
        if (out.error) return out.error;
        return `🌱 Saved “${out.base}” as new template version “${out.versionName}” (${out.stepCount} step${out.stepCount === 1 ? '' : 's'}, reset). The original is untouched — “batch new ${out.base}” now starts from this version.`;
      }) },
    { match: ({ t }) => /^\/?batch\s+log\s+([\s\S]+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        logLine(userId, r.batch.id, m[1].trim());
        return batchCard(userId, getBatchById(userId, r.batch.id));
      }) },
    { match: ({ t }) => /^\/?batch\s+done(?:\s+([\s\S]+))?$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveOpenBatch(userId);
        if (r.error) return r.error;
        const outcome = m[1]?.trim();
        if (!outcome) {
          setDialogState(userId, { type: 'batch_done', data: { batchId: r.batch.id }, prompt: 'how did the batch turn out?' });
          return `🏁 Closing “${r.batch.name}” #${r.batch.batch_no} — how did it turn out? (Your next message is the outcome, or say “skip”.)`;
        }
        const out = closeBatch(userId, r.batch.id, outcome);
        return { ...batchCard(userId, out.batch), text: `🏁 Closed “${out.batch.name}” #${out.batch.batch_no}.\n\n${batchCard(userId, out.batch).text}` };
      }) },
    { match: ({ t }) => /^\/?batch\s+history\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => historyReply(userId, m[1].trim())) },
    // ── Recipe-version lineage (reversible reject/unreject). Parse "<base> #<n>" with familyOf. ──
    { match: ({ t }) => /^\/?batch\s+versions?\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => versionsReply(userId, m[1].trim())) },
    { match: ({ t }) => /^\/?batch\s+unreject\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const { base, n } = familyOf(m[1].trim());
        const out = unrejectVersion(userId, base, n);
        if (out.error) return out.error;
        return `↺ Restored “${out.versionName}” to the “${out.base}” lineage. Latest is now “${out.latest}”.`;
      }) },
    { match: ({ t }) => /^\/?batch\s+reject\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const { base, n } = familyOf(m[1].trim());
        const out = rejectVersion(userId, base, n);
        if (out.error) return out.error;
        if (out.emptied) return `✗ Rejected “${out.versionName}”. ⚠️ That was the last active version — “batch new ${out.base}” has nothing to start from until you unreject one or save a new version.`;
        return `✗ Rejected “${out.versionName}” — dropped from the lineage. “batch new ${out.base}” now starts from “${out.latest}”. (“batch unreject ${out.base} #${out.n}” restores it.)`;
      }) },
    { match: ({ t }) => /^\/?batch\s+delete\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const name = m[1].trim();
        const runs = listBatches(userId, name);
        if (!runs.length) return `No batches called “${name}” — bare “batches” lists yours.`;
        setDialogState(userId, { type: 'batch_delete', data: { name: runs[0].name }, prompt: `delete the “${runs[0].name}” batches?` });
        return `⚠️ Delete “${runs[0].name}” — all ${runs.length} run${runs.length === 1 ? '' : 's'} and their logs? Say “delete” to confirm, or “keep”.`;
      }) },
    // Bare "batch [name]": the current open run. LAST of the specific forms so the verbs above win; the
    // name arm also catches any unrecognized "batch …" tail, answering with resolve-or-usage.
    { match: ({ t }) => /^\/?batch(?:\s+(.+))?$/i.exec(t),
      run: gated(({ userId }, m) => {
        const name = m[1]?.trim() || null;
        const r = resolveOpenBatch(userId, name);
        if (r.error) return name && !listBatches(userId, name).length ? `${r.error}\n\n${USAGE}` : r.error;
        return batchCard(userId, r.batch);
      }) },
  ],
  dialogHandlers: {
    batch_log: (userId, text, ds) => {
      clearDialogState(userId);
      const batch = getBatchById(userId, Number(ds.data?.batchId));
      if (!batch) return 'That batch is gone — bare “batches” lists yours.';
      logLine(userId, batch.id, text);
      return batchCard(userId, batch);
    },
    batch_add_step: (userId, text, ds) => {
      clearDialogState(userId);
      const out = addBatchStep(userId, Number(ds.data?.batchId), text);
      if (!out) return 'That batch is gone — bare “batches” lists yours.';
      if (out.error) return out.error;
      return batchCard(userId, out.batch);
    },
    batch_done: (userId, text, ds) => {
      clearDialogState(userId);
      const batch = getBatchById(userId, Number(ds.data?.batchId));
      if (!batch) return 'That batch is gone — bare “batches” lists yours.';
      const skip = /^(skip|none|no|nah|nvm|never ?mind)[\s.!?]*$/i.test(text.trim());
      const out = closeBatch(userId, batch.id, skip ? null : text.trim());
      if (out.already) return `“${batch.name}” #${batch.batch_no} was already closed.`;
      return { ...batchCard(userId, out.batch), text: `🏁 Closed “${out.batch.name}” #${out.batch.batch_no}.\n\n${batchCard(userId, out.batch).text}` };
    },
    batch_delete: (userId, text, ds) => {
      const ans = deleteConfirmAnswer(text);
      if (!ans) return 'Say “delete” to confirm, or “keep” to cancel.';
      clearDialogState(userId);
      const name = String(ds.data?.name || '');
      if (ans !== 'confirm') return `Kept “${name}” — nothing deleted.`;
      const n = deleteBatchesByName(userId, name);
      return n ? `✓ Deleted “${name}” — ${n} run${n === 1 ? '' : 's'} and their logs went with it.` : `Couldn’t find “${name}” anymore — nothing deleted.`;
    },
  },
  menuActions: {
    // All values are batch ROW ids; every handler re-resolves with the user_id scope, so a forged or
    // stale id gets a gentle "gone" (the timer `tmr` pattern).
    bch: (userId, d) => { // toggle one step — value is "<batchId>.<pos>"
      const [bid, pos] = String(d.value || '').split('.').map(Number);
      const out = Number.isInteger(bid) && bid > 0 ? toggleBatchItems(userId, bid, [pos]) : null;
      if (!out) return GONE;
      return { ...batchCard(userId, out.batch), toast: out.changed.length ? '✓' : 'No such step' };
    },
    bca: (userId, d) => {
      const out = checkAllBatchItems(userId, Number(d.value));
      if (!out) return GONE;
      return { ...batchCard(userId, out.batch), toast: 'All done ✅' };
    },
    blg: (userId, d) => { // arm the log dialog — the next message is the line
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      setDialogState(userId, { type: 'batch_log', data: { batchId: batch.id }, prompt: 'the next message goes into the log' });
      return { text: `📓 Go ahead — your next message lands in the “${batch.name}” #${batch.batch_no} log, dated today.` };
    },
    bas: (userId, d) => { // arm the add-step dialog — the next message is the new step
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      if (batch.status !== 'open') return { ...batchCard(userId, batch), toast: 'Closed run' };
      setDialogState(userId, { type: 'batch_add_step', data: { batchId: batch.id }, prompt: 'the next message is the new step' });
      return { text: `➕ Go ahead — your next message becomes a new step on “${batch.name}” #${batch.batch_no}.` };
    },
    bsv: (userId, d) => { // save the batch's tweaked steps as a new template version
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      const out = saveBatchAsVersion(userId, batch.id);
      if (!out) return GONE;
      if (out.error) return { ...batchCard(userId, batch), toast: 'Nothing to save', text: out.error };
      return { ...batchCard(userId, batch), toast: `Saved ${out.versionName} 🌱`, text: `🌱 Saved as new version “${out.versionName}” (${out.stepCount} step${out.stepCount === 1 ? '' : 's'}). “batch new ${out.base}” now starts from it.\n\n${batchCard(userId, batch).text}` };
    },
    bdn: (userId, d) => { // arm the close dialog — the next message is the outcome
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      if (batch.status !== 'open') return { ...batchCard(userId, batch), toast: 'Already closed' };
      setDialogState(userId, { type: 'batch_done', data: { batchId: batch.id }, prompt: 'how did the batch turn out?' });
      return { text: `🏁 Closing “${batch.name}” #${batch.batch_no} — how did it turn out? (Your next message is the outcome, or say “skip”.)` };
    },
    bop: (userId, d) => {
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      return batchCard(userId, batch);
    },
    bhi: (userId, d) => { // history for that batch's process
      const batch = getBatchById(userId, Number(d.value));
      if (!batch) return GONE;
      return historyReply(userId, batch.name);
    },
  },
});
