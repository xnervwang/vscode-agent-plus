// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * What the session list keeps for a project (src/session-store.js), with two stores on one file standing in for two
 * windows: each keeps the other's changes, the change made last wins a field, the newest reply seen only grows, a
 * deleted group stays deleted, archiving moves a conversation out of its group and unpins it unless told to keep the
 * pin, and a lock left by a window that died is taken over.
 */
const fs = require('fs');
const path = require('path');

module.exports = async ({ eq, tmp, root, wait }) => {
  const S = require(path.join(root, 'src', 'session-store.js'));
  const dir = tmp('session-store');
  let clock = 1000;
  const now = () => clock;
  const { key } = S.projectOf(['/w/proj'], undefined);
  eq([S.projectOf(['/w/proj']).key === S.projectOf(['/w/proj', '/w/other']).key, S.projectOf(['/w/proj']).key === S.projectOf(['/w/proj'], '/w/a.code-workspace').key,
    S.projectOf([], undefined).label], [true, false, '(no folder)'], 'a project is its first folder, or its saved workspace file when there is one');

  const a = S.createStore({ dir, key, now, label: 'proj' }), b = S.createStore({ dir, key, now });
  const A = ['codex', 't-a'], B = ['claude-code', 's-b'];
  const g = a.newGroup('  Plugins   work ');
  a.setGroup([A], g);
  eq([a.record(...A).group, a.groups().map((x) => x.name)], [g, ['Plugins work']], 'a change shows in its own window before it is written');
  a.flush();
  clock = 2000; b.setGroup([B], g); b.pin([B], true); b.flush();
  clock = 3000; a.color([A], 'green'); a.color([B], 'not a colour'); a.flush();
  eq([b.record(...A), b.record(...B)].map((r) => [r.group, r.pinned, r.color]), [[g, false, 'green'], [g, true, null]],
    'each window keeps the other\'s changes, and a name that is not a colour clears the colour');

  /* The same field from both: the later change wins, whichever is written last. */
  clock = 5000; b.color([A], 'red');
  clock = 4000; a.color([A], 'blue');
  b.flush(); a.flush();
  eq(a.record(...A).color, 'red', 'the change made last wins, whichever window writes last');

  /* The newest reply seen only grows; marking unread and seeing it again. */
  a.seen(...A, 900); b.seen(...A, 700); a.flush(); b.flush();
  clock = 6000; a.markUnread([A], true); a.flush();
  const marked = [b.record(...A).seenAt, b.record(...A).unreadMark];
  clock = 7000; b.seen(...A, 950); b.flush();
  eq([marked, [a.record(...A).seenAt, a.record(...A).unreadMark]], [[900, true], [950, false]],
    'the newest reply seen never goes back; marking unread holds until the conversation is seen again');

  /* Archiving. */
  clock = 8000; a.archive([B], true); a.flush();
  const archived = b.record(...B);
  clock = 9000; a.archive([B], true); a.flush();
  clock = 10000; b.archive([A], true, { since: 777, keepPin: true }); b.pin([A], true); b.flush();
  clock = 11000; b.archive([A], true, { keepPin: true }); b.flush();
  eq([[archived.archived, archived.archivedAt, archived.group, archived.pinned], a.record(...B).archivedAt, [a.record(...A).archivedAt, a.record(...A).pinned]],
    [[true, 8000, null, false], 8000, [777, true]],
    'archiving moves it out of its group and unpins it, keeps the first time it was archived, and an import can give that time and keep the pin');
  clock = 12000; a.archive([B], false); a.flush();
  eq([b.record(...B).archived, b.record(...B).archivedAt, b.record(...B).group], [false, 0, null], 'unarchiving puts it in no group');

  /* Groups: rename, order, delete. */
  const g2 = b.newGroup('Second'), g3 = b.newGroup('Third'); b.flush();
  a.moveGroup(g3, g); a.renameGroup(g2, 'Renamed'); a.flush();
  eq(b.groups().map((x) => x.name), ['Third', 'Plugins work', 'Renamed'], 'groups keep the order the user put them in, and a rename');
  const C = ['opencode', 'ses_c'];
  a.setGroup([C], g); a.flush();
  clock = 13000; b.deleteGroup(g); b.flush();
  clock = 12500; a.renameGroup(g, 'Back from the dead'); a.flush();
  eq([a.groups().map((x) => x.name), a.groupKnown(g), a.record(...C).group], [['Third', 'Renamed'], true, g],
    'a deleted group stays deleted even through an older rename, and its conversations keep its id, which reads as no group');
  eq([a.renameGroup(g2, '   '), b.groups().length], [false, 2], 'a group needs a name');

  /* A lock left behind by a window that died. */
  fs.mkdirSync(path.join(dir, `${key}.json.lock`));
  clock = 14000; a.pin([['opencode', 'ses_x']], true);
  const blocked = a.flush();
  fs.utimesSync(path.join(dir, `${key}.json.lock`), new Date(0), new Date(0));
  clock = 14000 + S.LOCK_STALE_MS + 1000;
  await wait(S.LOCK_STALE_MS > 0 ? 150 : 0);
  eq([blocked, a.pending(), b.record('opencode', 'ses_x').pinned], [false, 0, true],
    'a write that finds the lock taken waits, and takes over a lock older than the stale time');

  let may = false;
  const ro = S.createStore({ dir, key: 'readonly0000000a', now, writable: () => may });
  ro.pin([['codex', 'ro']], true);
  const held = [ro.flush(), ro.record('codex', 'ro').pinned, fs.existsSync(path.join(dir, 'readonly0000000a.json'))];
  may = true;
  eq([held, ro.flush(), fs.existsSync(path.join(dir, 'readonly0000000a.json'))], [[false, true, false], true, true],
    'while it may not write, as in Restricted Mode, a change shows in this window only, and is written once it may');
  ro.dispose();
  eq(b.keys().map((k) => k.join('/')).sort(), ['claude-code/s-b', 'codex/t-a', 'opencode/ses_c', 'opencode/ses_x'], 'keys lists every conversation the store has something for');
  a.markImported('codex'); a.swept(); a.flush();
  eq([b.imported('codex') > 0, b.imported('claude-code'), b.sweepAt() > 0], [true, 0, true], 'it records which sources were imported and when the list last swept');
  a.dispose(); b.dispose();
};
