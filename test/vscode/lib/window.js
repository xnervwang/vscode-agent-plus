// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * One VS Code window of the downloaded build, started with the profile that run.js created. It is driven two ways:
 * Playwright over the DevTools protocol for the page itself, and helper/ for the vscode API (see helper/extension.js).
 * `dev` lists the development extensions to load besides the helper. From test/vscode/lib/window.js of Codex Plus,
 * which loads its helper only and names its control folder CODEX_PLUS_UI_CONTROL.
 *
 * The DevTools port is 0, so two runs on one machine do not collide; Chromium writes the port it took to
 * DevToolsActivePort in the user data folder.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, '..', 'helper');
const SECRETS = ['--use-inmemory-secretstorage', ...(process.platform === 'linux' ? ['--password-store=basic'] : [])];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The flags @vscode/test-electron's runTests passes, for the same reasons, and secrets kept in memory, since HOME is a
   temporary folder with no keychain or keyring. Workspace trust is left on only for a window that asks for it. */
const FLAGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--no-cached-data', ...SECRETS];

async function until(test, ms, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

/* `exe` is VS Code's executable, `profile` { exts, user, folder, control } from run.js, and `env` the environment the
   window gets. `trust` leaves workspace trust to the window's settings; `args` go on the command line as well. */
async function open({ exe, profile, env, playwright, log, dev = [], trust = false, args: more = [] }) {
  fs.mkdirSync(profile.control, { recursive: true });
  for (const n of fs.readdirSync(profile.control)) if (/^host-\d+\.json$/.test(n)) fs.rmSync(path.join(profile.control, n), { force: true });
  const portFile = path.join(profile.user, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [profile.folder, ...FLAGS, ...(trust ? [] : ['--disable-workspace-trust']), `--extensions-dir=${profile.exts}`, `--user-data-dir=${profile.user}`,
    `--extensionDevelopmentPath=${HELPER}`, ...dev.map((d) => `--extensionDevelopmentPath=${d}`), '--remote-debugging-port=0', ...more];
  const proc = spawn(exe, args, { env: { ...env, AGENT_PLUS_UI_CONTROL: profile.control }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(log);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  let exited = null;
  proc.on('exit', (code, signal) => { exited = code === null ? signal : code; });

  const port = await until(() => {
    if (exited !== null) throw new Error(`VS Code exited (${exited}) before it opened a DevTools port; see ${log}`);
    const text = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : '';
    return /^\d+/.test(text) ? Number(text.split('\n')[0]) : 0;
  }, 90000);
  if (!port) throw new Error(`VS Code wrote no DevToolsActivePort in 90 s; see ${log}`);
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const workbench = () => browser.contexts().flatMap((c) => c.pages()).find((p) => /workbench\.html/.test(p.url()));
  const page = await until(workbench, 60000);
  if (!page) throw new Error('no workbench page among the DevTools targets');
  await page.waitForSelector('.monaco-workbench', { timeout: 90000 });

  let next = 0;
  const hosts = () => fs.readdirSync(profile.control).filter((n) => /^host-\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(profile.control, n), 'utf8')));
  /* The newest extension host's pid, once there is one newer than `after` (ms since the epoch). */
  const hostUp = async (after = 0) => {
    const h = await until(() => hosts().filter((x) => x.at > after).sort((a, b) => b.at - a.at)[0], 120000);
    if (!h) throw new Error('the helper extension did not start in the extension host in 120 s');
    return h;
  };
  /* Runs `body` in the extension host, as an async function of (vscode, require, arg), and returns what it returns. */
  const call = async (body, arg, ms = 60000) => {
    const id = `r${process.pid}-${++next}`;
    const tmp = path.join(profile.control, `.${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ body, arg }));
    fs.renameSync(tmp, path.join(profile.control, `${id}.req.json`));
    const res = path.join(profile.control, `${id}.res.json`);
    const got = await until(() => fs.existsSync(res), ms, 100);
    if (!got) throw new Error(`no answer from the extension host in ${ms / 1000} s to: ${body.slice(0, 120)}`);
    const r = JSON.parse(fs.readFileSync(res, 'utf8'));
    fs.rmSync(res, { force: true });
    if (!r.ok) throw new Error(`in the extension host: ${r.error}`);
    return r.value;
  };
  /* Quits through VS Code first, which writes the profile's state as a person closing it would; a signal only if that
     does not end it. */
  const close = async () => {
    try { await call('setTimeout(() => vscode.commands.executeCommand("workbench.action.quit"), 100); return true;', undefined, 10000); } catch (_) { /* gone */ }
    await until(() => exited !== null, 20000);
    try { await browser.close(); } catch (_) { /* gone */ }
    if (exited === null) { try { proc.kill('SIGTERM'); } catch (_) { /* gone */ } }
    await until(() => exited !== null, 15000);
    if (exited === null) { try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } }
    await until(() => exited !== null, 5000);
    out.end();
  };
  return { browser, page, call, hostUp, close, proc };
}

module.exports = { open, until, sleep, SECRETS };
