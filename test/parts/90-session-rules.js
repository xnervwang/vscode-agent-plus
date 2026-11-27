// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's rules (src/session-rules.js).
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const R = require(path.join(root, 'src', 'session-rules.js'));
  const DAY = R.DAY_MS, now = 1000 * DAY;
  const row = (o) => Object.assign({ key: o.sessionId || o.title, sourceId: 'codex', sessionId: o.title, title: o.title,
    lastActiveAt: now - DAY, activity: 'stopped' }, o);

  /* ── Dots ── */
  const dots = [
    row({ title: 'dialog', activity: 'waiting', waitingFor: { kind: 'permission', tool: 'Bash' } }),
    row({ title: 'dialog with a question too', activity: 'waiting', waitingFor: { kind: 'choice' }, asks: true }),
    row({ title: 'no reason', activity: 'waiting' }),
    row({ title: 'asked, stopped', asks: true }),
    row({ title: 'asked through the plan', activity: 'waiting', waitingFor: { kind: 'planQuestion' } }),
    row({ title: 'asked, still working', activity: 'working', asks: true }),
    row({ title: 'asked, background left', activity: 'background', asks: true }),
    row({ title: 'working', activity: 'working' }),
    row({ title: 'background', activity: 'background' }),
    row({ title: 'stopped' }),
  ].map((r) => [r.title, R.dotOf(r)]);
  eq(dots, [['dialog', 'blue'], ['dialog with a question too', 'blue'], ['no reason', 'blue'], ['asked, stopped', 'red'],
    ['asked through the plan', 'red'], ['asked, still working', 'redRing'], ['asked, background left', 'redRing'],
    ['working', 'green'], ['background', 'greenRing'], ['stopped', '']],
  'a dialog waiting is blue and comes first; a plan question is red, or a red ring while a turn or background work runs; then a turn is green, background work alone a green ring, and the rest have no dot');
  eq([R.needsYou(row({ title: 'a', activity: 'waiting' })), R.needsYou(row({ title: 'b', asks: true, activity: 'working' })),
    R.needsYou(row({ title: 'c', activity: 'working' }))], [true, true, false], 'Needs you is blue and both reds');

  /* ── Stripes ── */
  eq([R.stripeOf(row({ title: 'a', here: true, elsewhere: [{ label: 'x' }], closedAt: 5 })),
    R.stripeOf(row({ title: 'b', elsewhere: [{ label: 'x' }], closedAt: 5 })), R.stripeOf(row({ title: 'c', closedAt: 5 })),
    R.stripeOf(row({ title: 'd', elsewhere: [] }))],
  ['here', 'elsewhere', 'closed', ''], 'the stripe is for open here first, then open elsewhere, then closed here lately');

  /* ── Unread ── */
  eq([R.unread(row({ title: 'a', lastReplyAt: 10, seenAt: 9 })), R.unread(row({ title: 'b', lastReplyAt: 10, seenAt: 10 })),
    R.unread(row({ title: 'c', lastReplyAt: 10, seenAt: 5, viewedAt: 12 })), R.unread(row({ title: 'd', lastReplyAt: 10, seenAt: 20, unreadMark: true })),
    R.unread(row({ title: 'e' }))],
  [true, false, false, true, false], 'a reply after the last one seen is unread, the agent\'s own viewed time counts as seen, and the mark wins');

  /* ── Sections and order ── */
  const groups = [{ id: 'g1', name: 'Plugins' }, { id: 'g2', name: 'Empty but made', made: true }, { id: 'g3', name: 'Empty' }];
  const rows = [
    row({ title: 'old pinned', lastActiveAt: now - 9 * DAY, pinned: true }),
    row({ title: 'new', lastActiveAt: now - DAY }),
    row({ title: 'newest', lastActiveAt: now - 60e3 }),
    row({ title: 'in group', group: 'g1', lastActiveAt: now - 3 * DAY }),
    row({ title: 'pinned in group', group: 'g1', pinned: true, lastActiveAt: now - 8 * DAY }),
    row({ title: 'archived', archived: true, group: 'g1' }),
    row({ title: 'lost group', group: 'gone' }),
    row({ title: 'closed early', closedAt: 1 }),
    row({ title: 'closed late', closedAt: 2 }),
    row({ title: 'closed and open again', closedAt: 3, here: true }),
  ];
  const out = R.sections(rows, { groups, recent: 10 });
  eq(out.map((s) => [s.key, s.rows.map((r) => r.title)]), [
    ['closed', ['closed late', 'closed early']],
    ['group:g1', ['pinned in group', 'in group']],
    ['group:g2', []],
    ['ungrouped', ['old pinned', 'newest', 'closed and open again', 'closed early', 'closed late', 'lost group', 'new']],
    ['archived', ['archived']],
  ], 'Recently closed, the groups in order (an empty one only if made here), Ungrouped and Archived; pinned first, then newest first, then by title');
  eq(R.sections(rows, { groups, recent: 1 })[0].rows.map((r) => r.title), ['closed late'], 'Recently closed keeps only the newest, up to the number set');
  eq(R.sections([row({ title: 'ran first', lastActiveAt: now - 10e3, sortAt: now - 600e3 }), row({ title: 'quiet', lastActiveAt: now - 300e3 }),
    row({ title: 'ran later', lastActiveAt: now - 20e3, sortAt: now - 120e3 })], { groups: [] }).find((s) => s.key === 'ungrouped').rows.map((r) => r.title),
  ['ran later', 'quiet', 'ran first'], 'a row with a sortAt sorts by it in place of its lastActiveAt');

  /* ── Filters and counts ── */
  const mixed = [row({ title: 'a', here: true }), row({ title: 'b', activity: 'working' }), row({ title: 'c', activity: 'background', asks: true }),
    row({ title: 'd', activity: 'waiting' }), row({ title: 'e' })];
  eq(R.counts(mixed), { all: 5, open: 1, running: 2, needs: 2 }, 'the chips count All, Open (in this window), Running (a turn or background work) and Needs you');

  /* ── Archiving on its own ── */
  const old = { lastActiveAt: now - 20 * DAY };
  const due = (o) => R.archiveDue(row(Object.assign({ title: 'x' }, old, o)), { days: 14, now, groups: new Set(['g1']) });
  eq([due({}), due({ lastActiveAt: now - 13 * DAY }), due({ here: true }), due({ elsewhere: [{ label: 'terminal' }] }),
    due({ activity: 'working' }), due({ activity: 'background' }), due({ activity: 'waiting' }), due({ asks: true }),
    due({ lastReplyAt: now, seenAt: 0 }), due({ group: 'g1' }), due({ group: 'deleted group' }), due({ pinned: true }), due({ archived: true }),
    R.archiveDue(row(Object.assign({ title: 'off' }, old)), { days: 0, now })],
  [true, false, false, false, false, false, false, false, false, false, true, false, false, false],
  'a conversation inactive for the days set is archived, unless it is open, running, waiting, asking, unread, grouped, pinned or archived already; 0 days turns this off');

  /* ── Deleting ── */
  const del = (o) => R.deleteBlocker(row(Object.assign({ title: 'x', archived: true }, o)));
  eq([del({}), del({ archived: false }), del({ pinned: true }), del({ here: true }), del({ elsewhere: [{ label: 'a terminal' }] }), del({ activity: 'working' })],
    ['', 'only an archived conversation can be deleted', 'it is pinned', 'it is open in this window', 'it is open in a terminal', 'it is running'],
    'only an archived conversation that is not pinned, open anywhere or running can be deleted, and the list says why not');
  const at = (o) => R.deleteDueAt(row(Object.assign({ title: 'x', archived: true }, o)), { days: 90 });
  eq([at({ archivedAt: now - 100 * DAY, lastActiveAt: now - 200 * DAY }), at({ archivedAt: now - 100 * DAY, lastActiveAt: now - 10 * DAY }),
    at({ archived: false }), at({ pinned: true }), R.deleteDueAt(row({ title: 'off', archived: true, archivedAt: 1 }), { days: 90, on: false })],
  [now - 10 * DAY, now + 80 * DAY, null, null, null],
  'deleting on its own counts from the later of when it was first seen archived and its last activity; never for a conversation that is not archived, is pinned, or when deleting is off');
  eq([R.deleteDue(row({ title: 'a', archived: true, archivedAt: now - 91 * DAY, lastActiveAt: now - 91 * DAY }), { days: 90, now }),
    R.deleteDue(row({ title: 'b', archived: true, archivedAt: now - 91 * DAY, lastActiveAt: now - 91 * DAY, here: true }), { days: 90, now })],
  [true, false], 'a conversation that is due is deleted only if nothing blocks it');

  /* ── Search ── */
  const s = row({ title: 'Fix the Login', sessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', branch: 'feature/auth' });
  const o = row({ title: 'x', sessionId: 'ses_df3c28ab2ffe0TYFbXAnoBpqy6' });
  eq([R.matches(s, 'login'), R.matches(s, 'AUTH'), R.matches(s, 'bbbb-7c'), R.matches(s, 'bbb'), R.matches(o, 'TYFbX'), R.matches(s, 'nothing'), R.matches(s, '')],
    [true, true, true, false, true, false, true], 'search matches the title or branch in any case, and four or more characters of any agent\'s id');
};
