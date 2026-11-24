// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage: node test/vscode/run.js <Agent Plus .vsix> [--out <dir>] [--vscode <executable>] [--local] [--look]
 *
 * Downloads the newest stable VS Code (unless --vscode names one), installs the .vsix into a profile of its own, and
 * runs ui.js against that install: it opens real windows with this extension and the stand-in source in source/,
 * drives them through Playwright and checks what they draw. Exits non-zero if a check fails. Screenshots and VS Code's
 * logs go to --out (by default a folder in the temporary root it makes).
 *
 * HOME (USERPROFILE on Windows), VS Code's user data and extensions folders, the shared folder of every window
 * (~/.agent-work-plan) and the stand-in source's plans all point into a new folder under RUNNER_TEMP or the system's
 * temporary folder. It still refuses to run outside CI unless --local is given. A run changes the request limit in the
 * service-worker.js of the VS Code it uses and puts it back, so two runs at the same time must not share a VS Code given
 * with --vscode.
 *
 * After the download the window stage runs as a child of this script, with the proxy of every program it starts set
 * to 127.0.0.1:9, where nothing listens: nothing in that stage needs the network.
 *
 * With --look every step also saves a close view and the whole window at twice the pixel density, listed in look.json.
 *
 * Needs @vscode/test-electron and playwright-core, which the workflow installs; on Linux a display (xvfb-run).
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return ''; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const NO_PROXY_TO = 'http://127.0.0.1:9';

/* The environment for VS Code and everything it starts, with HOME in the temporary root. When this script runs inside
   VS Code, ELECTRON_RUN_AS_NODE would start the test VS Code as plain Node and VSCODE_IPC_HOOK_CLI would send its
   installs to the outer one, so both go, and so does LD_LIBRARY_PATH: VS Code brings its own libraries. */
function cleanEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_|AGENT_WORK_PLAN_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  const home = path.join(root, 'home');
  Object.assign(env, { HOME: home, AGENT_PLUS_UI_PLANS: path.join(root, 'plans') }, extra);
  if (process.platform === 'win32') Object.assign(env, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
  if (process.platform === 'linux') Object.assign(env, { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') });
  return env;
}

function profileOf(root) {
  return { exts: path.join(root, 'exts'), user: path.join(root, 'user'), folder: path.join(root, 'ws'), control: path.join(root, 'ctl'),
    home: path.join(root, 'home'), plans: path.join(root, 'plans'), shared: path.join(root, 'home', '.agent-work-plan') };
}

/* The VS Code command line tool beside `exe`, as @vscode/test-electron finds it; a .cmd on Windows, run through a shell. */
function cli(te, exe) {
  const tool = te.resolveCliArgsFromVSCodeExecutablePath(exe, { reuseMachineInstall: true })[0];
  return (argv, env) => {
    const shell = process.platform === 'win32';
    const r = cp.spawnSync(shell ? `"${tool}"` : tool, shell ? argv.map((a) => `"${a}"`) : argv, { env, encoding: 'utf8', shell, maxBuffer: 64 << 20 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  };
}

async function fetchStage() {
  const vsix = path.resolve(args[0] || '');
  if (!args[0] || !fs.existsSync(vsix)) throw new Error('usage: node test/vscode/run.js <Agent Plus .vsix> [--out <dir>] [--vscode <exe>] [--local] [--look]');
  const te = require('@vscode/test-electron');
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'awp-'));
  const out = path.resolve(OUT || path.join(root, 'out'));
  const p = profileOf(root);
  for (const d of [p.exts, p.user, p.folder, p.control, p.home, p.plans, out]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    const d = cleanEnv(root)[k];
    if (d && d.startsWith(p.home)) fs.mkdirSync(d, { recursive: true });
  }
  console.log(`temporary root ${root}; results in ${out}`);

  const exe = VSCODE ? path.resolve(VSCODE) : await te.downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(root, 'vscode') });
  const code = cli(te, exe);
  const env = cleanEnv(root);
  const r = code(['--install-extension', vsix, `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`], env);
  console.log(r.out.split('\n').filter((l) => !/DeprecationWarning|trace-deprecation/.test(l)).join('\n'));
  if (r.status !== 0) throw new Error(`installing ${vsix} failed (${r.status})`);
  console.log('installed:\n' + code(['--list-extensions', '--show-versions', `--extensions-dir=${p.exts}`, `--user-data-dir=${p.user}`], env).out);

  const child = cp.spawnSync(process.execPath, [__filename, '--stage', 'test', '--root', root, '--exe', exe, '--out', out, ...(LOOK ? ['--look'] : [])],
    { stdio: 'inherit', env: process.env });
  process.exitCode = child.status === 0 ? 0 : 1;
  /* On a developer's machine the root is removed once the results are copied out; a CI runner is thrown away. */
  if (!out.startsWith(root + path.sep) && process.env.CI !== 'true' && !process.env.AGENT_PLUS_UI_KEEP) fs.rmSync(root, { recursive: true, force: true });
}

/* ── the window stage, in the child ── */
async function testStage() {
  const root = flag('--root'), exe = flag('--exe'), out = OUT;
  const p = profileOf(root);
  const playwright = require('playwright-core');
  const ui = require('./ui');
  const proxy = { HTTP_PROXY: NO_PROXY_TO, HTTPS_PROXY: NO_PROXY_TO, ALL_PROXY: NO_PROXY_TO, http_proxy: NO_PROXY_TO, https_proxy: NO_PROXY_TO,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const env = cleanEnv(root, proxy);

  let failed = 0, passed = 0, notes = 0;
  const check = (cond, what, detail) => {
    if (cond) { passed++; console.log(`  ok    ${what}`); return true; }
    failed++;
    console.log(`  FAIL  ${what}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return false;
  };
  const note = (what) => { notes++; console.log(`  note  ${what}`); };

  fs.writeFileSync(path.join(p.folder, 'notes.txt'), 'A file to have an editor open that is not a conversation.\n');
  fs.mkdirSync(path.join(p.user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(p.user, 'User', 'settings.json'), JSON.stringify(Object.assign({
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none',
    'workbench.colorTheme': 'Default Dark Modern', 'chat.disableAIFeatures': true, 'git.enabled': false,
    'http.proxy': NO_PROXY_TO, 'http.proxySupport': 'override', 'http.noProxy': ['127.0.0.1', 'localhost'],
    /* Draw modal dialogs, such as a work plan row's description, inside the window so Playwright can read them and
       click their buttons. VS Code's default is the system dialog on every platform. */
    'window.dialogStyle': 'custom',
    'window.newWindowDimensions': 'maximized',
    'window.menuStyle': 'custom',
    'window.confirmBeforeClose': 'never',
    /* Breadcrumbs would put this machine's temporary folders in the screenshots. */
    'breadcrumbs.enabled': false,
    /* A terminal put back in the panel of an untrusted window makes VS Code ask for trust. */
    'terminal.integrated.hideOnStartup': 'always',
    'terminal.integrated.enablePersistentSessions': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  }, LOOK ? ui.LOOK_SETTINGS : {}), null, 2));

  try {
    await ui.run({ exe, profile: p, env, playwright, out, check, note, look: LOOK });
  } catch (e) {
    check(false, 'the window stage ran to its end', (e && e.stack) || String(e));
  }
  keepLogs(p.user, path.join(out, 'logs'));
  if (LOOK) fs.copyFileSync(path.join(HERE, '..', '..', 'shared', 'test', 'vscode', 'LOOK.md'), path.join(out, 'LOOK.md'));
  console.log(`\n${LOOK ? 'look run' : 'VS Code window'}: ${passed} passed, ${failed} failed, ${notes} notes; screenshots in ${path.join(out, 'shots')}`);
  process.exitCode = failed ? 1 : 0;
}

/* Copies the logs of every window this run opened into the results, and prints Agent Plus's own log. */
function keepLogs(user, to) {
  const from = path.join(user, 'logs');
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)]));
  for (const f of walk(to).filter((f) => /Agent Plus\.log$/.test(f))) {
    console.log(`\n--- ${path.relative(to, f)}`);
    console.log(fs.readFileSync(f, 'utf8'));
  }
}

const STAGE = flag('--stage');
const OUT = flag('--out');
const VSCODE = flag('--vscode');
const LOCAL = has('--local');
const LOOK = has('--look');
(async () => {
  if (STAGE === 'test') return testStage();
  if (process.env.CI !== 'true' && !LOCAL) throw new Error('runs only where CI=true, or with --local: it starts VS Code and installs extensions');
  return fetchStage();
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
