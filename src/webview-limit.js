// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview service worker lets at most 32 host-served resource responses be in flight at once, for every
 * webview tab in every window (out/vs/workbench/contrib/webview/browser/pre/service-worker.js, since 1.130.0). A
 * response that is never read to the end keeps its slot, and a webview tab (Claude Code's, Codex's) whose scripts wait
 * for a slot stays blank. This raises that limit in the client's copy of the file. From src/webview-limit.js of
 * vscode-claude-code-extras bb28f51; Agent Plus is the only extension of the three that changes it.
 *
 * The file lives in the VS Code app on the client machine. In a remote window that is not this machine, and the
 * client's files are reached through the vscode-local scheme. The running installation is the one whose product.json
 * commit matches the remote server's.
 *
 * The file is minified, so the number is written `maxActiveHostResourceResponseBodies=32,`. It is changed only where
 * that text appears exactly once. An update replaces the whole application and brings 32 back, so this is checked at
 * every start. The new value is read by VS Code only after it has been quit completely and opened again.
 *
 * Three kinds of file are made beside it while a change is under way, all named after this extension, and none of them
 * outlives it: a change that goes through leaves the VS Code application with nothing of this extension's in it.
 *   .lock       which window is changing the file (see withLock)
 *   .backup.*   the file as it was before this change, one per change and removed only by the change that made it, once
 *               the new text is read back; a replacement that failed part-way leaves it, find({ repair }) puts the file
 *               back from it, and a later pass removes it once it is too old to belong to a change still under way
 *   .*.tmp      the new text, before it is renamed over the original; removed on the way out
 * A copy is never shared between two changes. Two windows can both believe they hold the lock (below), and a change
 * that went ahead without a copy of its own, because another window's was there, is left with none once that window
 * removes it.
 *
 * None of this can be made atomic from here. Every window of every remote reaches the client's files through
 * workspace.fs, which has no exclusive create and no atomic replace:
 *   - rename(a, b, { overwrite: false }) is a check of b followed by a plain rename, in both the file service
 *     (fileService.ts doValidateMoveCopy) and the disk provider (diskFileSystemProvider.ts validateMoveCopy), and a
 *     plain POSIX rename replaces whatever is at b. Two windows can pass the check and the second wins.
 *   - rename(a, b, { overwrite: true }) deletes b first and then renames (fileService.ts doMoveCopy), so there is a
 *     moment with no file at b at all.
 * So the lock is advisory: it says who, and every step that could destroy another window's work reads the file back
 * and acts only on what it still finds there. Windows of one machine also take turns through a lock of their own
 * (`hold`, from src/request-limit.js), which is exclusive; this one is what is left for windows of different machines.
 */
const SW = 'out/vs/workbench/contrib/webview/browser/pre/service-worker.js';
const NAME = 'maxActiveHostResourceResponseBodies';
const OLD = 32;
const NEW = 1000000;
const FOUND = new RegExp(NAME + '=(\\d+),', 'g');

const LOCK_SUFFIX = '.agent-work-plan.lock';
const BACKUP_SUFFIX = '.agent-work-plan.backup';
/* A lock older than this was left by a window that died holding it. A change takes well under a second. */
const LOCK_STALE_MS = 60000;
const LOCK_TRIES = 40;
const LOCK_POLL_MS = 250;

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

async function stat(fs, uri) { try { return await fs.stat(uri); } catch (_) { return null; } }
async function exists(fs, uri) { return !!(await stat(fs, uri)); }
async function readText(fs, uri) { try { return decode(await fs.readFile(uri)); } catch (_) { return null; } }
async function names(fs, uri) { try { return (await fs.readDirectory(uri)).map((e) => e[0]); } catch (_) { return []; } }

/** Candidate VS Code locations on the client, for each platform, as vscode-local paths. */
async function candidates(fs, at) {
  const out = [];
  const users = await names(fs, at('/Users'));
  for (const app of ['Visual Studio Code', 'Visual Studio Code - Insiders']) {
    out.push(`/Applications/${app}.app/Contents/Resources/app`);
    for (const u of users) out.push(`/Users/${u}/Applications/${app}.app/Contents/Resources/app`);
  }
  for (const dir of ['code', 'code-insiders']) out.push(`/usr/share/${dir}/resources/app`);
  out.push('/opt/visual-studio-code/resources/app', '/snap/code/current/usr/share/code/resources/app');
  const winRoots = [];
  for (const app of ['Microsoft VS Code', 'Microsoft VS Code Insiders']) {
    winRoots.push(`/c:/Program Files/${app}`);
    for (const u of await names(fs, at('/c:/Users'))) winRoots.push(`/c:/Users/${u}/AppData/Local/Programs/${app}`);
  }
  for (const root of winRoots) {
    out.push(root + '/resources/app');
    for (const sub of await names(fs, at(root))) out.push(`${root}/${sub}/resources/app`);
  }
  return out;
}

/** The commit in an application root's product.json, or ''. */
async function commitOf(fs, at, root) {
  try { return String(JSON.parse(decode(await fs.readFile(at(root + '/product.json')))).commit || ''); } catch (_) { return ''; }
}

const sibling = (uri, suffix) => uri.with({ path: uri.path + suffix });
const token = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e, fallback) => (e && (e.code || (typeof e.name === 'string' && /NoPermissions|FileNotFound|FileExists/.test(e.name) && e.name))) || fallback;
const millis = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/*
 * The time it is on the client, in the milliseconds its file system stamps files with. The extension host can be on
 * another machine whose clock is minutes away from the client's, so the age of a lock file is never measured against
 * Date.now(): a file of this extension's own is written in the same folder and its mtime is what "now" means there.
 * 0 when it could not be written, and then no lock is ever called stale.
 */
async function clientNow(fs, uri) {
  const probe = sibling(uri, `${LOCK_SUFFIX}.now.${token()}`);
  try {
    await fs.writeFile(probe, encode('.'));
    const st = await stat(fs, probe);
    return st ? millis(st.mtime) : 0;
  } catch (_) {
    return 0;
  } finally {
    try { await fs.delete(probe); } catch (_) { /* never written */ }
  }
}

/** The token in the lock file: which window holds it. '' when there is no lock, or it says something else. */
async function holderOf(fs, lock) {
  const text = await readText(fs, lock);
  if (text === null) return '';
  try {
    const holder = JSON.parse(text).holder;
    return typeof holder === 'string' ? holder : '';
  } catch (_) { return ''; }
}

/*
 * Runs `fn` holding the lock beside `uri`. Resolves to fn()'s result, or 'locked' when another window held it
 * throughout, or the error's code when the lock file could not be made at all. `hold(run)`, when given, is the lock
 * of this machine's windows and is taken first.
 *
 * The lock file says which window holds it, and that is what every destructive step goes by: a lock is taken over only
 * while it is still the same too-old lock that was read, and released only while it is still this window's own. Without
 * that, two windows that both find one stale delete each other's replacement, and a window whose own work ran past
 * LOCK_STALE_MS deletes the lock of whoever took over from it.
 */
async function withLock(fs, uri, fn, { wait = sleep, hold } = {}) {
  if (typeof hold === 'function') return hold(() => withLock(fs, uri, fn, { wait }));
  const lock = sibling(uri, LOCK_SUFFIX);
  const me = token() + token();
  const mine = sibling(uri, `${LOCK_SUFFIX}.${me}`);
  const body = encode(JSON.stringify({ holder: me }));
  /* The client's clock is asked for once; how long has passed since then is this machine's own measurement, which does
     not need the two clocks to agree. */
  let base = -1, took = 0;
  const there = async () => {
    if (base < 0) { base = await clientNow(fs, uri); took = Date.now(); }
    return base ? base + (Date.now() - took) : 0;
  };
  let held = false, code = '';
  for (let i = 0; i < LOCK_TRIES && !held && !code; i++) {
    const other = await stat(fs, lock);
    if (other) {
      const holder = await holderOf(fs, lock);
      if (holder === me) { held = true; break; }
      const now = await there();
      if (now && now - millis(other.mtime) > LOCK_STALE_MS) {
        const still = await stat(fs, lock);
        if (still && millis(still.mtime) === millis(other.mtime) && (await holderOf(fs, lock)) === holder) {
          try { await fs.delete(lock); } catch (_) { /* taken over meanwhile */ }
          continue;
        }
      }
      await wait(LOCK_POLL_MS);
      continue;
    }
    try { await fs.writeFile(mine, body); } catch (e) { code = codeOf(e, 'unwritable'); break; }
    let moved = false;
    try { await fs.rename(mine, lock, { overwrite: false }); moved = true; } catch (_) { /* another window has it */ }
    if (!moved) { try { await fs.delete(mine); } catch (_) { /* the rename took it after all */ } }
    if ((await holderOf(fs, lock)) === me) { held = true; break; }
    await wait(LOCK_POLL_MS);
  }
  if (code) return code;
  if (!held) return 'locked';
  try {
    return await fn();
  } finally {
    if ((await holderOf(fs, lock)) === me) { try { await fs.delete(lock); } catch (_) { /* gone already */ } }
  }
}

const dirOf = (uri) => uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) || '/' });
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * The copies beside `uri`: one per change that has not finished, named after it, and the single `.backup` an earlier
 * version of this extension made.
 */
async function copiesOf(fs, uri) {
  const dir = dirOf(uri);
  const base = uri.path.slice(uri.path.lastIndexOf('/') + 1) + BACKUP_SUFFIX;
  const own = new RegExp('^' + escape(base) + '(\\.[0-9a-z]+)?$');
  return (await names(fs, dir)).filter((n) => own.test(n)).map((n) => dir.with({ path: dir.path.replace(/\/$/, '') + '/' + n }));
}

/*
 * Keeps `text` beside `uri` as the file is now, before the change called `name` replaces it. '' when there is a copy to
 * restore from afterwards, the error's code when there is not. The copy is this change's alone, and it counts only once
 * it has been read back whole.
 */
async function keepCopy(fs, uri, text, name = token() + token()) {
  const backup = sibling(uri, `${BACKUP_SUFFIX}.${name}`);
  const tmp = sibling(uri, `${BACKUP_SUFFIX}.${name}.tmp`);
  let why = '';
  try {
    await fs.writeFile(tmp, encode(text));
    if ((await readText(fs, tmp)) !== text) why = 'not-written';
    else await fs.rename(tmp, backup, { overwrite: false });
  } catch (e) {
    why = codeOf(e, 'unwritable');
  }
  try { await fs.delete(tmp); } catch (_) { /* renamed, or never written */ }
  if (!why && (await readText(fs, backup)) !== text) why = 'not-written';
  if (why) { try { await fs.delete(backup); } catch (_) { /* never made */ } }
  return why;
}

/** The text of the newest copy beside `uri` this extension could have made: one that names the limit exactly once. */
async function copyText(fs, uri) {
  let best = null, at = -1;
  for (const copy of await copiesOf(fs, uri)) {
    const text = await readText(fs, copy);
    if (text === null || [...text.matchAll(FOUND)].length !== 1) continue;
    const st = await stat(fs, copy);
    const when = st ? millis(st.mtime) : 0;
    if (when > at) { best = text; at = when; }
  }
  return best;
}

/*
 * Puts the file back from the copy beside it. '' when it is there again, 'gone' when there is no copy to use, or the
 * error's code. Called for a file that could not be read at all, which is what a replacement interrupted between the
 * delete and the rename leaves behind. The copy stays: a change in another window may still be counting on it, and
 * tidy() removes it once it is old enough not to be.
 */
async function restore(fs, uri, timing) {
  if ((await copyText(fs, uri)) === null) return 'gone';
  return withLock(fs, uri, async () => {
    if (await exists(fs, uri)) return '';
    const copy = await copyText(fs, uri);
    if (copy === null) return 'gone';
    const tmp = sibling(uri, `.agent-work-plan.${token()}.tmp`);
    let why = '';
    try {
      await fs.writeFile(tmp, encode(copy));
      if ((await readText(fs, tmp)) !== copy) why = 'not-written';
      /* Not overwriting: a file that appeared meanwhile is another window's replacement landing, and it stays. */
      else await fs.rename(tmp, uri, { overwrite: false });
    } catch (e) {
      why = codeOf(e, 'unwritable');
    }
    try { await fs.delete(tmp); } catch (_) { /* renamed, or never written */ }
    if ((await readText(fs, uri)) !== null) return '';
    return why || 'not-written';
  }, timing);
}

/*
 * Removes the copies a change left behind, once the file names the limit again. A copy younger than LOCK_STALE_MS on
 * the client's clock can belong to a change still under way in another window, and is kept. Returns how many went.
 */
async function tidy(fs, uri, timing) {
  if (!(await copiesOf(fs, uri)).length) return 0;
  const gone = await withLock(fs, uri, async () => {
    const text = await readText(fs, uri);
    if (text === null || [...text.matchAll(FOUND)].length !== 1) return 0;
    const now = await clientNow(fs, uri);
    if (!now) return 0;
    let n = 0;
    for (const copy of await copiesOf(fs, uri)) {
      const st = await stat(fs, copy);
      if (!st || now - millis(st.mtime) <= LOCK_STALE_MS) continue;
      try { await fs.delete(copy); n++; } catch (_) { /* removed by another window */ }
    }
    return n;
  }, timing);
  return typeof gone === 'number' ? gone : 0;
}

/**
 * Finds the installations of the VS Code running this window, each with the limit its service worker has: `limit` is a
 * number, or null when the text does not appear exactly once, as in a VS Code version that changed this code.
 *
 * `local` is true for a window on this machine, where `appRoot` is the application itself; in a remote window
 * `commit` is the server's commit and the client is searched. With `repair`, a service worker that cannot be read at
 * all is put back from the copy beside it first, and `restored` says so; without it nothing is written.
 */
async function find({ fs, at, local, appRoot, commit, repair = false, timing }) {
  let roots;
  if (local) roots = [appRoot];
  else {
    roots = [];
    for (const root of await candidates(fs, at)) {
      if (!(await exists(fs, at(root + '/product.json')))) continue;
      if (commit && (await commitOf(fs, at, root)) === commit) roots.push(root);
    }
  }
  const out = [];
  for (const root of roots) {
    const uri = at(root + '/' + SW);
    let text = await readText(fs, uri);
    let restored = false, lost = '';
    if (text === null && repair) {
      const why = await restore(fs, uri, timing);
      if (why) lost = why; else { restored = true; text = await readText(fs, uri); }
    }
    if (text === null) {
      if (lost && lost !== 'gone') out.push({ root, uri, limit: null, lost });
      continue;
    }
    if (repair) await tidy(fs, uri, timing);
    const hits = [...text.matchAll(FOUND)];
    out.push({ root, uri, limit: hits.length === 1 ? Number(hits[0][1]) : null, restored });
  }
  return out;
}

/**
 * Changes the limit in one installation from `from` to `to`, then reads the file back to confirm. Returns '' when done,
 * 'changed' when the file no longer contains `from` exactly once and does not already say `to`, or changed after it was
 * read, 'locked' when another window kept the lock, 'dropped' when `timing.wanted()` said no before the file was
 * replaced, or the error's code (EPERM, EACCES, ...).
 */
async function setLimit(fs, install, from, to, timing = {}) {
  const wanted = () => typeof timing.wanted !== 'function' || timing.wanted() !== false;
  return withLock(fs, install.uri, async () => {
    if (!wanted()) return 'dropped';
    const text = await readText(fs, install.uri);
    if (text === null) return 'unreadable';
    const was = NAME + '=' + from + ',';
    const want = NAME + '=' + to + ',';
    /* Another window can make the same change between the pass that found `from` and this one. A file that already
       says `to` is this call's own outcome, not something to send the reader off to a shell for. */
    const outcome = (now) => (now.split(want).length === 2 ? '' : 'changed');
    if (text.split(was).length !== 2) return outcome(text);
    const next = text.replace(was, want);
    const name = token() + token();
    const kept = await keepCopy(fs, install.uri, text, name);
    if (kept) return kept;
    const mine = sibling(install.uri, `${BACKUP_SUFFIX}.${name}`);
    const dropCopy = async () => { try { await fs.delete(mine); } catch (_) { /* gone already */ } };
    const tmp = sibling(install.uri, `.agent-work-plan.${token()}.tmp`);
    const dropTmp = async () => { try { await fs.delete(tmp); } catch (_) { /* renamed, or never written */ } };
    try {
      await fs.writeFile(tmp, encode(next));
      if ((await readText(fs, tmp)) !== next) { await dropTmp(); await dropCopy(); return 'not-written'; }
      /* The last look before the original is deleted. An update of VS Code in place, or another window, may have
         changed the file since it was read, and replacing it now would put back text made from what it was. */
      const now = await readText(fs, install.uri);
      if (now !== text || !wanted()) {
        await dropTmp();
        /* With no file there, this copy may be the one thing to put it back from. */
        if (now !== null) await dropCopy();
        if (now === null) return 'unreadable';
        return now !== text ? outcome(now) : 'dropped';
      }
      await fs.rename(tmp, install.uri, { overwrite: true });
    } catch (e) {
      await dropTmp();
      /* The copy stays: the rename deletes the original before moving, so the file may be gone, and find({ repair })
         is what puts it back. */
      return codeOf(e, 'unwritable');
    }
    const back = await readText(fs, install.uri);
    if (back === null) return 'unreadable';
    if (!back.includes(want)) return 'not-written';
    /* The file is there with the value asked for, so this change's copy has nothing left to protect. Copies other
       changes made are theirs to remove. */
    await dropCopy();
    return '';
  }, timing);
}

/** A command that makes the same change by hand, for an installation this extension cannot write to. */
function byHand(install, platformHint, from = OLD, to = NEW) {
  const file = install.root.replace(/^\/([a-z]):/i, (m, d) => d.toUpperCase() + ':') + '/' + SW;
  const was = `${NAME}=${from},`, want = `${NAME}=${to},`;
  if (/^[a-z]:/i.test(file)) {
    const win = file.replace(/\//g, '\\');
    return `$f = '${win}'; [IO.File]::WriteAllText($f, [IO.File]::ReadAllText($f).Replace('${was}', '${want}'))`;
  }
  const mac = platformOf(install.root, platformHint) === 'darwin' || file.startsWith('/Applications/') || file.startsWith('/Users/');
  const sed = mac ? "sed -i ''" : 'sed -i';
  return `sudo ${sed} 's/${was}/${want}/' '${file}'`;
}

/*
 * 'darwin', 'win32' or 'linux' for an installation root. `localPlatform` is the extension host's, which in a remote
 * window is the remote's and says nothing about the client; the paths a Linux package installs VS Code in say Linux.
 */
function platformOf(root, localPlatform) {
  if (/^\/?[a-z]:/i.test(root)) return 'win32';
  if (/\.app\/Contents\/Resources\/app$/.test(root)) return 'darwin';
  if (/^\/(usr|opt|snap)\//.test(root)) return 'linux';
  if (root.startsWith('/')) return localPlatform === 'darwin' ? 'darwin' : (localPlatform === 'win32' ? 'win32' : 'linux');
  return localPlatform;
}

module.exports = { SW, NAME, OLD, NEW, LOCK_SUFFIX, BACKUP_SUFFIX, LOCK_STALE_MS, candidates, clientNow, holderOf,
  copiesOf, keepCopy, copyText, restore, tidy, find, withLock, setLimit, byHand, platformOf };
