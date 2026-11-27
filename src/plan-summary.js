// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The figures a plan bar draws above an agent's input box, from one conversation's plan (planSummary in
 * docs/protocol.md, shared/page/plan-bar.js).
 *
 * It reads a plan as src/workplan.js parsed it and numbers rows as the work plan view does: by their place in the file,
 * 1, 2.1.1. A plan keeps a row or a placeholder for everything it was ever given, so a long conversation's plan holds
 * hundreds of closed rows; counted against those, a bar would stay all but full whatever the conversation does now. So
 * the rows archived beside the plan, closed more than a day ago (`archived` in src/workplan.js), are left out with
 * everything under them. No editor API here: the tests load it directly.
 */
const { planQuestions } = require('./folders');

/* The states a bar counts. `dropped` is not counted, and neither is a state this build does not know (docs/protocol.md,
   Plan files). */
const COUNTED = ['done', 'doing', 'waiting', 'discussing', 'todo', 'parked'];
const MAX_OPEN = 30;
const MAX_TITLE = 200;

/* Every row in file order that is neither archived nor under an archived row, with its number and its depth (1 at the
   top). An archived row's place still counts for the numbers after it. */
function walk(nodes, prefix = '', depth = 1, out = []) {
  (nodes || []).forEach((n, i) => {
    const number = (prefix ? prefix + '.' : '') + (i + 1);
    if (n.archived) return;
    out.push({ n, number, depth });
    walk(n.children, number, depth + 1, out);
  });
  return out;
}

const row = (r, dim) => ({ number: r.number, title: String(r.n.title || '').slice(0, MAX_TITLE), state: r.n.state, dim: !!dim });
/* Whether a row waits for the user's answer, as planQuestions in src/folders.js counts them. */
const asks = (n) => n.waitingOn === 'user' && (n.state === 'waiting' || n.state === 'discussing');

/*
 * The summary of `plan`, or null when there is nothing for a bar to draw, such as no plan or a plan that does not parse
 * or has no rows.
 *
 * The current row is the deepest `doing` row, the earlier in the file at equal depth. A plan without a `doing` row has
 * no current row: a row picked from the others would mostly be the oldest one waiting, which says nothing about what is
 * going on.
 */
function summarize(plan) {
  if (!plan || plan.error || !Array.isArray(plan.nodes) || !plan.nodes.length) return null;
  const rows = walk(plan.nodes);
  const counts = { discussing: 0, todo: 0, doing: 0, waiting: 0, parked: 0, done: 0 };
  const asking = { discussing: 0, waiting: 0 };
  const open = [], questions = [];
  let deepest = null, unknown = 0;
  for (const r of rows) {
    const state = r.n.state;
    if (!COUNTED.includes(state)) { if (state !== 'dropped') unknown++; continue; }
    counts[state]++;
    if (state === 'done') continue;
    const ask = asks(r.n);
    if (ask) {
      asking[state]++;
      if (questions.length < MAX_OPEN) {
        questions.push({ number: r.number, title: String(r.n.title || '').slice(0, MAX_TITLE), question: String(r.n.question || r.n.title || '').slice(0, MAX_TITLE) });
      }
    }
    if (open.length < MAX_OPEN) open.push({ number: r.number, title: String(r.n.title || '').slice(0, MAX_TITLE), state, depth: r.depth, ...(ask ? { asks: true } : {}) });
    if (state === 'doing' && (!deepest || r.depth > deepest.depth)) deepest = r;
  }
  const total = COUNTED.reduce((sum, k) => sum + counts[k], 0);
  const allDone = total === counts.done && !unknown;
  if (!total && !allDone) return null;
  const current = deepest ? row(deepest, false) : null;
  return {
    total, done: counts.done, counts, current, allDone,
    questions: planQuestions(plan.nodes).length, asking, asks: questions, open,
  };
}

/* Whether two summaries draw the same bar. */
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

module.exports = { summarize, same, COUNTED, MAX_OPEN, MAX_TITLE };
