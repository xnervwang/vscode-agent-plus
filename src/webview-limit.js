// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * VS Code's webview service worker lets at most 32 host-served resource responses be in flight at once, for every
 * webview tab in every window (out/vs/workbench/contrib/webview/browser/pre/service-worker.js, since 1.130.0). A
 * response that is never read to the end keeps its slot, and a webview tab (Claude Code's, Codex's) whose scripts wait
 * for a slot stays blank. This raises that limit in the client's copy of the file. From src/webview-limit.js of
 * vscode-claude-code-extras bb28f51; Agent Work Plan is the only extension of the three that changes it.
 *
 * The file lives in the VS Code app on the client machine. In a remote window that is not this machine, and the
 * client's files are reached through the vscode-local scheme. The running installation is the one whose product.json
 * commit matches the remote server's.
 *
 * The file is minified, so the number is written `maxActiveHostResourceResponseBodies=32,`. It is changed only where
 * that text appears exactly once. An update replaces the whole application and brings 32 back, so this is checked at
 * every start. The new value is read by VS Code only after it has been quit completely and opened again.
 *
 * Every window of every remote checks the same client file, so a change is made under a lock file beside it, taken by
 * renaming a file of this window's own onto the lock's name without overwriting, which only one window can do. The new
 * text is written to a temporary file and renamed over the original, so VS Code never reads half a file.
 */
const SW = 'out/vs/workbench/contrib/webview/browser/pre/service-worker.js';
const NAME = 'maxActiveHostResourceResponseBodies';
const OLD = 32;
const NEW = 1000000;
const FOUND = new RegExp(NAME + '=(\\d+),', 'g');

const LOCK_SUFFIX = '.agent-work-plan.lock';
/* A lock older than this was left by a window that died holding it. A change takes well under a second. */
const LOCK_STALE_MS = 60000;
const LOCK_TRIES = 40;
const LOCK_POLL_MS = 250;

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

async function exists(fs, uri) { try { await fs.stat(uri); return true; } catch (_) { return false; } }
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

/**
 * Finds the installations of the VS Code running this window, each with the limit its service worker has: `limit` is a
 * number, or null when the text does not appear exactly once, as in a VS Code version that changed this code.
 *
 * `local` is true for a window on this machine, where `appRoot` is the application itself; in a remote window
 * `commit` is the server's commit and the client is searched.
 */
async function find({ fs, at, local, appRoot, commit }) {
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
    let text;
    try { text = decode(await fs.readFile(uri)); } catch (_) { continue; }
    const hits = [...text.matchAll(FOUND)];
    out.push({ root, uri, limit: hits.length === 1 ? Number(hits[0][1]) : null });
  }
  return out;
}

const sibling = (uri, suffix) => uri.with({ path: uri.path + suffix });
const token = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e, fallback) => (e && (e.code || (typeof e.name === 'string' && /NoPermissions|FileNotFound|FileExists/.test(e.name) && e.name))) || fallback;

/*
 * Runs `fn` holding the lock beside `uri`. Resolves to fn()'s result, or 'locked' when another window held it
 * throughout, or the error's code when the lock file could not be made at all.
 */
async function withLock(fs, uri, fn, { now = Date.now, wait = sleep } = {}) {
  const lock = sibling(uri, LOCK_SUFFIX);
  const mine = sibling(uri, `${LOCK_SUFFIX}.${token()}`);
  try { await fs.writeFile(mine, encode(JSON.stringify({ at: now() }))); } catch (e) { return codeOf(e, 'unwritable'); }
  let held = false;
  try {
    for (let i = 0; i < LOCK_TRIES && !held; i++) {
      try { await fs.rename(mine, lock, { overwrite: false }); held = true; break; } catch (_) { /* someone holds it */ }
      let st = null;
      try { st = await fs.stat(lock); } catch (_) { continue; }
      if (st && now() - st.mtime > LOCK_STALE_MS) { try { await fs.delete(lock); } catch (_) { /* taken over meanwhile */ } continue; }
      await wait(LOCK_POLL_MS);
    }
  } finally {
    if (!held) { try { await fs.delete(mine); } catch (_) { /* never made */ } }
  }
  if (!held) return 'locked';
  try { return await fn(); } finally { try { await fs.delete(lock); } catch (_) { /* gone already */ } }
}

/**
 * Changes the limit in one installation from `from` to `to`, then reads the file back to confirm. Returns '' when done,
 * 'changed' when the file no longer contains `from` exactly once, 'locked' when another window kept the lock, or the
 * error's code (EPERM, EACCES, ...).
 */
async function setLimit(fs, install, from, to, timing) {
  return withLock(fs, install.uri, async () => {
    let text;
    try { text = decode(await fs.readFile(install.uri)); } catch (e) { return codeOf(e, 'unreadable'); }
    const was = NAME + '=' + from + ',';
    if (text.split(was).length !== 2) return 'changed';
    const tmp = sibling(install.uri, `.agent-work-plan.${token()}.tmp`);
    try {
      await fs.writeFile(tmp, encode(text.replace(was, NAME + '=' + to + ',')));
      await fs.rename(tmp, install.uri, { overwrite: true });
    } catch (e) {
      try { await fs.delete(tmp); } catch (_) { /* never written */ }
      return codeOf(e, 'unwritable');
    }
    try {
      const back = decode(await fs.readFile(install.uri));
      return back.includes(NAME + '=' + to + ',') ? '' : 'not-written';
    } catch (e) { return codeOf(e, 'unreadable'); }
  }, timing);
}

/** A command that makes the same change by hand, for an installation this extension cannot write to. */
function byHand(install, platformHint) {
  const file = install.root.replace(/^\/([a-z]):/i, (m, d) => d.toUpperCase() + ':') + '/' + SW;
  if (/^[a-z]:/i.test(file)) {
    const win = file.replace(/\//g, '\\');
    return `$f = '${win}'; [IO.File]::WriteAllText($f, [IO.File]::ReadAllText($f).Replace('${NAME}=${OLD},', '${NAME}=${NEW},'))`;
  }
  const sed = platformHint === 'darwin' || file.startsWith('/Applications/') || file.startsWith('/Users/') ? "sed -i ''" : 'sed -i';
  return `sudo ${sed} 's/${NAME}=${OLD},/${NAME}=${NEW},/' '${file}'`;
}

/** 'darwin', 'win32' or 'linux' for an installation root. */
function platformOf(root, localPlatform) {
  if (/^\/?[a-z]:/i.test(root)) return 'win32';
  if (/\.app\/Contents\/Resources\/app$/.test(root)) return 'darwin';
  if (root.startsWith('/')) return localPlatform === 'darwin' ? 'darwin' : (localPlatform === 'win32' ? 'win32' : 'linux');
  return localPlatform;
}

module.exports = { SW, NAME, OLD, NEW, LOCK_SUFFIX, LOCK_STALE_MS, candidates, find, withLock, setLimit, byHand, platformOf };
