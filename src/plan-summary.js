// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * A conversation's plan in the few figures a plan bar draws above an agent's input box (planSummary in
 * docs/protocol.md, shared/page/plan-bar.js): how many rows are done of how many, the count in each state, the row to
 * show as the current one, how many questions wait for the user, and the rows still open.
 *
 * It reads a plan as src/workplan.js parsed it, closed rows moved out already put back, and numbers rows as the work
 * plan view does: by their place in the file, 1, 2.1.1. No editor API here: the tests load it directly.
 */
const { planQuestions } = require('./folders');

/* The states a bar counts, in the order it draws their segments. `dropped` is not counted, and neither is a state this
   build does not know (docs/protocol.md, Plan files). */
const COUNTED = ['done', 'doing', 'waiting', 'discussing', 'todo', 'parked'];
/* How many open rows the summary lists, for the bar's hover. */
const MAX_OPEN = 30;
const MAX_TITLE = 200;

/* Every row in file order, with its number and its depth: 1 for a row at the top, 2 for its children, and so on. */
function walk(nodes, prefix = '', depth = 1, out = []) {
  (nodes || []).forEach((n, i) => {
    const number = (prefix ? prefix + '.' : '') + (i + 1);
    out.push({ n, number, depth });
    walk(n.children, number, depth + 1, out);
  });
  return out;
}

const row = (r, dim) => ({ number: r.number, title: String(r.n.title || '').slice(0, MAX_TITLE), state: r.n.state, dim: !!dim });

/*
 * The summary of `plan` (readPlanAt() in src/workplan.js), or null when there is nothing for a bar to draw: no plan, a
 * plan that does not parse, or one with no counted row.
 *
 * The current row is the deepest `doing` row, the earlier in the file at equal depth; without one, the first `waiting`
 * row, then the first `discussing` and then the first `todo`. With only parked rows left it is the first parked row,
 * marked `dim`. With every counted row done there is none, and `allDone` is true.
 */
function summarize(plan) {
  if (!plan || plan.error || !Array.isArray(plan.nodes)) return null;
  const rows = walk(plan.nodes);
  const counts = { discussing: 0, todo: 0, doing: 0, waiting: 0, parked: 0, done: 0 };
  const open = [];
  let deepest = null;
  const first = {};
  for (const r of rows) {
    const state = r.n.state;
    if (!COUNTED.includes(state)) continue;
    counts[state]++;
    if (state === 'done') continue;
    if (open.length < MAX_OPEN) open.push({ number: r.number, title: String(r.n.title || '').slice(0, MAX_TITLE), state, depth: r.depth });
    if (state === 'doing' && (!deepest || r.depth > deepest.depth)) deepest = r;
    if (!first[state]) first[state] = r;
  }
  const total = COUNTED.reduce((sum, k) => sum + counts[k], 0);
  if (!total) return null;
  const pick = deepest || first.waiting || first.discussing || first.todo;
  const current = pick ? row(pick, false) : first.parked ? row(first.parked, true) : null;
  return {
    total, done: counts.done, counts, current, allDone: counts.done === total,
    questions: planQuestions(plan.nodes).length, open,
  };
}

/* Whether two summaries draw the same bar. */
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

module.exports = { summarize, same, COUNTED, MAX_OPEN, MAX_TITLE };
