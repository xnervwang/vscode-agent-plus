// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The page the Answer view shows when a conversation's row is clicked: the brief the agent wrote (the plan file's
 * `brief`, read in src/workplan.js), or, for a part not written yet, text put together from the plan and labelled as
 * such. src/answer-view.js draws the page; it is built here, without the editor API, so the tests can check it.
 */
const { openFirst, OPEN_STATES } = require('./workplan');

/*
 * The status is written as a turn ends, and that turn's last reply comes after it, a few seconds to a couple of minutes
 * later. Activity more than this long after it means another turn has run since.
 */
const STALE_MS = 5 * 60e3;
/* How many top-level rows the summary lists when the agent has written none. */
const TOP_ROWS = 6;

/** Whether the status was written before the conversation's latest turn (see STALE_MS). */
function stale(brief, lastActiveAt) {
  const at = brief && brief.status && brief.statusAt;
  return !!at && !!lastActiveAt && lastActiveAt - at > STALE_MS;
}

/* `b` comes from briefOf (src/conversations-view.js) and `t` from textFor (src/conversations-text.js). */
function page(b, t, age) {
  const brief = b.brief || null;
  const written = (at) => { const a = at ? age(at) : ''; return a ? t.briefWritten(a) : ''; };
  const sections = [];
  if (brief && brief.summary) {
    sections.push({ head: t.briefSummary, when: written(brief.summaryAt), auto: false, lines: [{ label: '', text: brief.summary }] });
  } else {
    const top = openFirst(b.top || []).slice(0, TOP_ROWS);
    const lines = top.map((r) => ({ label: r.row + '.', text: `${r.title} (${r.state})` }));
    if ((b.top || []).length > top.length) lines.push({ label: '', text: t.briefMoreRows((b.top || []).length - top.length) });
    if (!lines.length) lines.push({ label: '', text: b.hasPlan ? t.briefNoRows : t.noPlan });
    sections.push({ head: t.briefSummary, when: '', auto: true, lines });
  }
  if (brief && brief.status) {
    const s = brief.status;
    sections.push({ head: t.briefStatus, when: written(brief.statusAt), auto: false,
      stale: stale(brief, b.lastActiveAt) ? t.briefStale : '',
      lines: [{ label: t.briefDoing, text: s.doing }, { label: t.briefProgress, text: s.progress }, { label: t.briefNext, text: s.next }] });
  } else {
    const lines = (b.doing || []).map((d) => ({ label: t.briefDoing, text: `${d.row}. ${d.title}${d.note ? ' · ' + d.note : ''}` }));
    if (!lines.length) lines.push({ label: t.briefDoing, text: t.briefNothingDoing });
    const ago = b.lastActiveAt ? age(b.lastActiveAt) : '';
    lines.push({ label: t.briefLastActive, text: ago ? t.briefAgo(ago) : t.briefUnknown });
    sections.push({ head: t.briefStatus, when: '', auto: true, lines });
  }
  /* While a turn is running, a line with its state and the `doing` rows. */
  let live = '';
  if (b.running && (b.state === 'working' || b.state === 'prompt')) {
    const rows = (b.doing || []).map((d) => { const a = age(d.since); return `${d.row}. ${d.title}${a ? ` (${t.doing(a)})` : ''}`; });
    live = t.briefLive(t.state[b.state], rows.join('; '));
  }
  return {
    type: 'brief', key: b.key, title: b.title || b.sessionId || '', sections, live, gone: b.gone ? t.briefGone : '',
    auto: t.briefAuto,
  };
}

function topRows(nodes) {
  return (nodes || []).map((n, i) => ({ row: String(i + 1), title: n.title, state: n.state, open: OPEN_STATES.includes(n.state) }));
}

module.exports = { page, stale, topRows, STALE_MS, TOP_ROWS };
