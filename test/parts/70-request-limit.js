// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview request limit: found, changed under a lock beside the file, written through a temporary file with a
 * copy of the original kept, and left alone in Restricted Mode. The client's file system is held in memory,
 * asynchronous like the real one (test/limit-fs.js).
 */
const path = require('path');
const fake = require('../fake-vscode');
const { client } = require('../limit-fs');

module.exports = async ({ ok, bad, eq, root, tmp, wait }) => {
  const wl = require(path.join(root, 'src', 'webview-limit.js'));
  const APP = '/opt/code/resources/app';
  const SW = `${APP}/${wl.SW}`;
  const LOCK = SW + wl.LOCK_SUFFIX;
  const BACKUP = SW + wl.BACKUP_SUFFIX;
  const text = (n) => `a();${wl.NAME}=${n},b();`;
  const fresh = (n = 32, extra = {}, opts) => client(Object.assign({ [`${APP}/product.json`]: '{"commit":"abc"}', [SW]: text(n) }, extra), opts);
  const fast = { wait: async () => {} };
  const leftovers = (c) => Object.keys(c.files).filter((f) => /agent-work-plan/.test(f));
  const held = (c) => { try { return JSON.parse(c.files[LOCK]).holder; } catch (_) { return ''; } };

  const c = fresh();
  const [install] = await wl.find({ fs: c.fs, at: c.at, local: true, appRoot: APP });
  eq([install && install.limit, install && install.root], [32, APP], 'find() reads the limit of the running installation');
  eq(await wl.setLimit(c.fs, install, 32, wl.NEW, fast), '', 'setLimit() changes it');
  eq([c.files[SW], leftovers(c)], [text(wl.NEW), []],
    'the file holds the new value, and nothing of this extension\'s is left beside it: no copy, no lock, no temporary file');
  /* Another window can raise it between the pass that read 32 and this call. Sending the reader off to a shell then
     would be telling them to make a change that has already been made. */
  eq(await wl.setLimit(c.fs, install, 32, wl.NEW, fast), '', 'a file that already holds the new value counts as done');

  const other = fresh(500);
  eq(await wl.setLimit(other.fs, { root: APP, uri: other.at(SW) }, 32, wl.NEW, fast), 'changed',
    'a file holding neither the old nor the new value is left alone');

  const twice = client({ [SW]: text(32) + text(32) });
  eq(await wl.setLimit(twice.fs, { root: APP, uri: twice.at(SW) }, 32, wl.NEW, fast), 'changed', 'text found twice is not changed');

  const busy = fresh(32, { [LOCK]: JSON.stringify({ holder: 'another-window' }) });
  eq([await wl.setLimit(busy.fs, { root: APP, uri: busy.at(SW) }, 32, wl.NEW, fast), busy.files[SW], leftovers(busy)],
    ['locked', text(32), [LOCK]], 'with another window holding the lock, nothing changes and only that lock remains');

  const stale = fresh(32, { [LOCK]: JSON.stringify({ holder: 'a-window-that-died' }) });
  stale.meta.set(LOCK, { mtime: Date.now() - wl.LOCK_STALE_MS - 1000 });
  eq([await wl.setLimit(stale.fs, { root: APP, uri: stale.at(SW) }, 32, wl.NEW, fast), stale.files[SW], leftovers(stale)],
    ['', text(wl.NEW), []], 'a lock left by a window that died is removed');

  /* The extension host can be minutes away from the client whose files these are, so the age of a lock is measured
     against the client's own clock, taken from a file written in the same folder. */
  const behind = Date.now() - 600000;
  const skewed = fresh(32, { [LOCK]: JSON.stringify({ holder: 'a-live-window' }) }, { clock: () => behind });
  eq([await wl.setLimit(skewed.fs, { root: APP, uri: skewed.at(SW) }, 32, wl.NEW, fast), skewed.files[SW], held(skewed)],
    ['locked', text(32), 'a-live-window'], 'a lock on a client whose clock is ten minutes behind this one is not called stale');

  /* An operation that outlasts LOCK_STALE_MS is taken over, and what it must not do on the way out is delete the lock
     of whoever took over from it. */
  const over = fresh();
  const ran = await wl.withLock(over.fs, over.at(SW), async () => {
    const mine = held(over);
    over.files[LOCK] = JSON.stringify({ holder: 'took-over-from-me' });
    return mine;
  }, fast);
  eq([typeof ran, String(ran || '').length > 0, held(over)], ['string', true, 'took-over-from-me'],
    'the lock says which window holds it, and releasing leaves a lock that is no longer this window\'s');

  /* Two windows both find one lock too old. The second deletes it and takes the lock; the first must notice that what
     it judged stale is not what is there now. */
  const grabbed = fresh();
  grabbed.files[LOCK] = JSON.stringify({ holder: 'window-a' });
  grabbed.meta.set(LOCK, { mtime: Date.now() - wl.LOCK_STALE_MS - 1000 });
  let reads = 0;
  const watchful = Object.assign({}, grabbed.fs, {
    readFile: async (u) => {
      const bytes = await grabbed.fs.readFile(u);
      if (u.path === LOCK && ++reads === 1) {
        grabbed.files[LOCK] = JSON.stringify({ holder: 'window-b' });
        grabbed.meta.set(LOCK, { mtime: Date.now() });
      }
      return bytes;
    },
  });
  eq([await wl.setLimit(watchful, { root: APP, uri: grabbed.at(SW) }, 32, wl.NEW, fast), grabbed.files[SW], held(grabbed)],
    ['locked', text(32), 'window-b'], 'a lock another window took over between the look and the delete is left alone');

  const race = fresh();
  const target = { root: APP, uri: race.at(SW) };
  const slow = { wait: () => new Promise((r) => setTimeout(r, 2)) };
  const both = await Promise.all([wl.setLimit(race.fs, target, 32, wl.NEW, slow), wl.setLimit(race.fs, target, 32, wl.NEW, slow)]);
  eq([both, race.files[SW], leftovers(race)], [['', ''], text(wl.NEW), []],
    'two windows at once: one changes it, the other finds it already changed and says so too');

  /* With the rename VS Code really performs, both windows find the lock free and the second one's move replaces the
     first one's lock. The one whose lock was replaced must not go on to change the file. */
  const clobber = fresh(32, {}, { slowRename: true });
  let bodies = 0;
  const hold = { wait: () => new Promise((r) => setTimeout(r, 1)) };
  const two = await Promise.all([
    wl.withLock(clobber.fs, clobber.at(SW), async () => { bodies++; await wait(60); return 'ran'; }, hold),
    wl.withLock(clobber.fs, clobber.at(SW), async () => { bodies++; await wait(60); return 'ran'; }, fast),
  ]);
  if (bodies === 1 && two.includes('ran') && two.includes('locked')) {
    ok('when the exclusive rename is really a look then a move, only the window the lock ends up naming goes ahead');
  } else bad(`two windows past a non-exclusive rename: ${JSON.stringify(two)}, bodies ${bodies}`);

  const ro = fresh(32);
  const roClient = client(ro.files, { refuse: 'EACCES' });
  eq([await wl.setLimit(roClient.fs, { root: APP, uri: roClient.at(SW) }, 32, wl.NEW, fast), ro.files[SW], leftovers(roClient)],
    ['EACCES', text(32), []], 'a file that cannot be written gives the error\'s code and leaves nothing behind');

  /* An overwriting rename deletes the original before moving the new file over it, so one that fails in between leaves
     no file at all. The copy made just before it is what puts it back, and it is only kept for as long as that can
     still be needed. */
  const torn = fresh(32, {}, { tornRename: (p) => p === SW });
  const tornWhy = await wl.setLimit(torn.fs, { root: APP, uri: torn.at(SW) }, 32, wl.NEW, fast);
  const nothingThere = torn.files[SW];
  const [fixed] = await wl.find({ fs: torn.fs, at: torn.at, local: true, appRoot: APP, repair: true, timing: fast });
  eq([tornWhy, nothingThere, leftovers(torn).map((f) => f.startsWith(BACKUP + '.')), fixed && fixed.limit, fixed && fixed.restored, torn.files[SW]],
    ['EIO', undefined, [true], 32, true, text(32)],
    'a replacement that fails once the original is gone keeps the copy, and the next pass puts the file back from it');

  /* A replacement deletes the original before moving the new file over it, so an interruption in between leaves no file
     at all. That is what the copy is for. */
  const lostIt = fresh(wl.NEW);
  eq(await wl.keepCopy(lostIt.fs, lostIt.at(SW), text(32)), '', 'keepCopy() puts the original beside it');
  delete lostIt.files[SW];
  lostIt.meta.delete(SW);
  eq(await wl.find({ fs: lostIt.fs, at: lostIt.at, local: true, appRoot: APP }), [], 'without repair, a missing file is only skipped');
  const [putBack] = await wl.find({ fs: lostIt.fs, at: lostIt.at, local: true, appRoot: APP, repair: true, timing: fast });
  eq([putBack && putBack.limit, putBack && putBack.restored, lostIt.files[SW]], [32, true, text(32)],
    'a missing service worker is put back from the copy beside it');

  const junk = fresh(wl.NEW, { [BACKUP]: 'nothing of ours' });
  delete junk.files[SW];
  junk.meta.delete(SW);
  eq([await wl.find({ fs: junk.fs, at: junk.at, local: true, appRoot: APP, repair: true, timing: fast }), junk.files[SW]],
    [[], undefined], 'a copy that does not name the limit once is not written over anything');

  eq([/=32,/.test(wl.byHand({ root: APP }, 'linux')), wl.byHand({ root: APP }, 'linux', wl.NEW, wl.OLD).includes(`${wl.NAME}=${wl.NEW},/${wl.NAME}=${wl.OLD},`)],
    [true, true], 'the command to run by hand goes in the direction it is asked for');

  /* The prompt, Restricted Mode, and one window of this machine asking per VS Code build. */
  const { vscode, control } = fake.create();
  const undo = fake.install(vscode);
  fake.fresh(root);
  const limit = require(path.join(root, 'src', 'request-limit.js'));
  const home = tmp('limit-home');
  eq([limit.claimAsk('abc', home), limit.claimAsk('abc', home), limit.claimAsk('def', home)], [true, false, true],
    'of several windows coming back at once, one asks about each VS Code build');

  vscode.env.appRoot = APP;
  vscode.workspace.fs = {};
  let trusted = false;
  const asked = fresh();
  const host = { vscode, context: { globalState: fake.memento() }, say: (m) => control.state.log.push(m), trusted: () => trusted };
  const where = () => ({ fs: asked.fs, at: asked.at, local: true, appRoot: APP, commit: 'abc' });
  const l = limit.create(host, { where, timing: fast, delayMs: 0, home: tmp('limit-home-2') });
  await l.check();
  eq([control.state.said.length, asked.files[SW]], [0, text(32)], 'in Restricted Mode it does not even ask');
  trusted = true;
  control.answer('Raise the limit to 1000000', 'Raise it this time');
  await l.check();
  const msgs = control.state.said.map((s) => s.message);
  eq([asked.files[SW], msgs.some((m) => /is now 1000000/.test(m))], [text(wl.NEW), true], 'trusted, it asks once per VS Code build and raises it on request');
  await l.check();
  eq(control.state.said.filter((s) => /Raise the limit/.test(s.message)).length, 1, 'and does not ask again for the same build');
  await l.putBack();
  eq([asked.files[SW], control.state.configWrites.slice(-1)[0]], [text(32), ['agentPlus.webviewRequestLimit', 'leave']],
    'putting it back restores 32 and stops it being raised again');
  l.dispose();

  /* Putting it back while the reader still has the question open: the raise they are being asked about must not go
     ahead afterwards and undo what they just asked for. */
  const cancelled = fresh();
  const host2 = { vscode, context: { globalState: fake.memento() }, say: (m) => control.state.log.push(m), trusted: () => true };
  const l2 = limit.create(host2, { where: () => ({ fs: cancelled.fs, at: cancelled.at, local: true, appRoot: APP, commit: 'xyz' }),
    timing: fast, delayMs: 0, home: tmp('limit-home-3') });
  control.state.answers.length = 0;
  /* The previous instance left the setting at `leave`, which this one would honour by doing nothing at all. */
  delete control.state.config['agentPlus.webviewRequestLimit'];
  let putting = null;
  control.answer('Raise the limit to 1000000', () => { putting = l2.putBack(); return 'Raise it this time'; });
  control.state.said.length = 0;
  await l2.check();
  await putting;
  eq([cancelled.files[SW], control.state.log.some((m) => /dropped, it is no longer wanted/.test(m))], [text(32), true],
    'a restore while the question is open stops the raise it was asking about');
  l2.dispose();

  /* The same put-back arriving later, while the raise reads the file a second time after the answer: it is dropped
     there, inside the change itself, and has to be no more reported as made than the one stopped above. */
  let swReads = 0, putLater = null, l3 = null;
  const late = fresh(32, {}, { onRead: (p) => { if (p === SW && ++swReads === 2) putLater = l3.putBack(); } });
  const host3 = { vscode, context: { globalState: fake.memento() }, say: (m) => control.state.log.push(m), trusted: () => true };
  l3 = limit.create(host3, { where: () => ({ fs: late.fs, at: late.at, local: true, appRoot: APP, commit: 'late' }),
    timing: fast, delayMs: 0, home: tmp('limit-home-late') });
  control.state.answers.length = 0;
  delete control.state.config['agentPlus.webviewRequestLimit'];
  control.answer('Raise the limit to 1000000', 'Raise it this time');
  control.state.said.length = 0;
  await l3.check();
  await putLater;
  eq([late.files[SW], control.state.said.some((s) => /is now 1000000/.test(s.message))], [text(32), false],
    'a raise dropped part way is not reported as made, and the file is left at 32');
  l3.dispose();

  /* Putting it back has three different things to say, and "already 32" is only one of them. */
  const says = async (make) => {
    control.state.said.length = 0;
    const h = { vscode, context: { globalState: fake.memento() }, say: () => {}, trusted: () => true };
    const one = limit.create(h, { where: make, timing: fast, delayMs: 0, home: tmp('limit-home-4') });
    await one.putBack();
    one.dispose();
    return control.state.said.map((s) => s.message).join(' | ');
  };
  const already = fresh(32);
  const unknown = client({ [`${APP}/product.json`]: '{"commit":"abc"}', [SW]: text(32) + text(32) });
  const missing = client({});
  eq([
    /already 32/.test(await says(() => ({ fs: already.fs, at: already.at, local: true, appRoot: APP, commit: 'abc' }))),
    /does not name the limit once/.test(await says(() => ({ fs: unknown.fs, at: unknown.at, local: true, appRoot: APP, commit: 'abc' }))),
    /could not be found/.test(await says(() => ({ fs: missing.fs, at: missing.at, local: true, appRoot: APP, commit: 'abc' }))),
  ], [true, true, true], 'putting back tells apart "already 32", a file it does not recognise, and no installation found');

  undo();
};
