// Plain-language, DATA-GROUNDED summaries of what was done in a timeframe. No invented content —
// the narrative is built from real completed-task counts.
import { listCompletedTasksBetween } from './repo.js';
import { resolveTimeframe } from '../shared/timeframe.js';
import { CATEGORY_LABELS } from '../shared/categories.js';

export function summarize(userId, range = 'this_week') {
  const tf = resolveTimeframe(range);
  const tasks = listCompletedTasksBetween(userId, tf.start, tf.end);

  const byCategory = {};
  const byEffort = {};
  for (const t of tasks) {
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    byEffort[t.effort_level] = (byEffort[t.effort_level] || 0) + 1;
  }

  const n = tasks.length;
  let narrative;
  if (n === 0) {
    narrative = `You haven't marked anything done ${tf.label} yet — and that's okay. Small steps count. 🌱`;
  } else {
    const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${k} ${CATEGORY_LABELS[c] || c}`).join(', ');
    narrative = `You finished ${n} thing${n === 1 ? '' : 's'} ${tf.label}${cats ? ` — ${cats}` : ''}. Nice work. 🌱`;
  }

  return {
    range: tf.label,
    count: n,
    byCategory,
    byEffort,
    narrative,
    items: tasks.map((t) => ({ id: t.id, summary: t.summary, category: t.category, completed_at: t.completed_at })),
  };
}
