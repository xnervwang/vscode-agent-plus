// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's rules, as pure functions over plain values (docs/protocol.md, Session list): the dot of a row,
 * the stripe at its start, whether it is unread, the sections and their order, the filters and their counts, and what
 * may be archived or deleted, by hand or on its own. src/session-list.js gathers the values; the page draws the result.
 *
 * A row here is { key, sourceId, sessionId, title, lastActiveAt, lastReplyAt, viewedAt, activity, waitingFor, asks,
 * kind, here, elsewhere, pinned, archived, archivedAt, group, seenAt, unreadMark, closedAt }: what the source listed,
 * what this window and the other windows show, and what the store keeps for it. `asks` is whether the conversation's
 * plan asks the user a question put after the user's last message.
 */

const DAY_MS = 24 * 3600 * 1000;
const DOTS = ['blue', 'red', 'redRing', 'green', 'greenRing', ''];
const FILTERS = ['all', 'open', 'running', 'needs'];

/* The dot: a dialog waiting for the user wins, then a question in the plan, then a turn or background work running. A
   question while a turn or background work runs is drawn as a ring, since the agent is not yet waiting on it. */
function dotOf(row) {
  const a = row && row.activity;
  const kind = row && row.waitingFor && row.waitingFor.kind;
  if (a === 'waiting' && kind !== 'planQuestion') return 'blue';
  const busy = a === 'working' || a === 'background';
  if (row && (row.asks || (a === 'waiting' && kind === 'planQuestion'))) return busy ? 'redRing' : 'red';
  if (a === 'working') return 'green';
  if (a === 'background') return 'greenRing';
  return '';
}

const needsYou = (row) => ['blue', 'red', 'redRing'].includes(dotOf(row));
const runs = (row) => !!row && (row.activity === 'working' || row.activity === 'background');
/* Running or waiting for the user: what the agent is in the middle of. */
const busy = (row) => !!row && (runs(row) || row.activity === 'waiting');

/* The stripe at the start of a row: open in this window, open somewhere else, or closed here lately. */
function stripeOf(row) {
  if (!row) return '';
  if (row.here) return 'here';
  if (row.elsewhere && row.elsewhere.length) return 'elsewhere';
  if (row.closedAt > 0) return 'closed';
  return '';
}

/* Unread: marked unread by the user, or a reply later than the last one seen here and than the agent's own record of
   showing it. Seeing a conversation, or marking it read, clears the mark. */
function unread(row) {
  if (!row) return false;
  if (row.unreadMark || row.agentUnseen) return true;
  const seen = Math.max(+row.seenAt || 0, +row.viewedAt || 0);
  return +row.lastReplyAt > 0 && +row.lastReplyAt > seen;
}

/* Pinned first, then the rest, each newest first; the title, then the key, for rows that tie. */
function compare(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  const t = (+b.lastActiveAt || 0) - (+a.lastActiveAt || 0);
  if (t) return t;
  return String(a.title || '').localeCompare(String(b.title || '')) || String(a.key).localeCompare(String(b.key));
}

/*
 * The sections: Recently closed, then each group in `groups` order, Ungrouped, Archived. A conversation is in its
 * group, Ungrouped or Archived once; one closed in this window lately is in Recently closed as well, newest closed
 * first, at most `recent` of them. A group shows when it holds a row or `made` says the user made it here, which keeps
 * an empty group the user just made. `groups` is [{ id, name, made }] in the order the user put them.
 */
function sections(rows, { groups = [], recent = 10 } = {}) {
  const known = new Set(groups.map((g) => g.id));
  const live = rows.filter((r) => !r.archived);
  const out = [];
  const closed = rows.filter((r) => r.closedAt > 0 && !r.here).sort((a, b) => b.closedAt - a.closedAt).slice(0, Math.max(0, recent));
  out.push({ key: 'closed', label: 'Recently closed', rows: closed });
  for (const g of groups) {
    const inside = live.filter((r) => r.group === g.id).sort(compare);
    if (inside.length || g.made) out.push({ key: `group:${g.id}`, groupId: g.id, label: g.name, rows: inside, made: !!g.made });
  }
  out.push({ key: 'ungrouped', label: 'Ungrouped', rows: live.filter((r) => !r.group || !known.has(r.group)).sort(compare) });
  out.push({ key: 'archived', label: 'Archived', rows: rows.filter((r) => r.archived).sort(compare) });
  return out;
}

/* Whether a row passes a filter. Open is open in this window. */
function passes(row, filter) {
  if (filter === 'open') return !!row.here;
  if (filter === 'running') return runs(row);
  if (filter === 'needs') return needsYou(row);
  return true;
}

/* How many rows each filter keeps, counting each conversation once. */
function counts(rows) {
  const out = {};
  for (const f of FILTERS) out[f] = rows.filter((r) => passes(r, f)).length;
  return out;
}

/*
 * Whether the list archives this conversation on its own: inactive for `days` days and none of open here or
 * elsewhere, running or waiting, a plan question, unread, in a group, pinned.
 */
function archiveDue(row, { days, now = Date.now(), groups = null } = {}) {
  if (!(days > 0) || !row || row.archived || row.pinned) return false;
  if (row.group && (!groups || groups.has(row.group))) return false;
  if (row.here || (row.elsewhere && row.elsewhere.length) || busy(row) || dotOf(row) || unread(row)) return false;
  const last = +row.lastActiveAt || 0;
  return last > 0 && now - last >= days * DAY_MS;
}

/* Why a conversation cannot be deleted now, or '' when it can: only an archived one that is not pinned, that nothing
   has open and in which nothing runs. */
function deleteBlocker(row) {
  if (!row) return 'it is not in the list';
  if (!row.archived) return 'only an archived conversation can be deleted';
  if (row.pinned) return 'it is pinned';
  if (row.here) return 'it is open in this window';
  if (row.elsewhere && row.elsewhere.length) return `it is open in ${row.elsewhere[0].label || 'another place'}`;
  if (busy(row)) return 'it is running';
  return '';
}

/* When the list deletes an archived conversation on its own, counting from the later of when it was first seen
   archived and its last activity, or null for one it will not delete. */
function deleteDueAt(row, { days, on = true } = {}) {
  if (!on || !(days > 0) || !row || !row.archived || row.pinned) return null;
  const from = Math.max(+row.archivedAt || 0, +row.lastActiveAt || 0);
  return from > 0 ? from + days * DAY_MS : null;
}

function deleteDue(row, { days, on = true, now = Date.now() } = {}) {
  const at = deleteDueAt(row, { days, on });
  return at !== null && now >= at && !deleteBlocker(row);
}

/* Search: the title or branch holds the text, ignoring case; a query of four or more characters with no space also
   matches part of the id, which is how ids of every agent are searched (hex and hyphens, or OpenCode's ses_ ids). */
function matches(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if (String(row.title || '').toLowerCase().includes(q) || String(row.branch || '').toLowerCase().includes(q)) return true;
  return q.length >= 4 && !/\s/.test(q) && String(row.sessionId || '').toLowerCase().includes(q);
}

module.exports = { dotOf, needsYou, runs, busy, stripeOf, unread, compare, sections, passes, counts, archiveDue, deleteBlocker,
  deleteDueAt, deleteDue, matches, DAY_MS, DOTS, FILTERS };
