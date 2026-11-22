// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Usage, on Linux with a display:
 *
 *   NODE_PATH=<folder holding playwright-core> xvfb-run -a -s "-screen 0 3200x2000x24" \
 *     node test/look/conversations-panel.js --vscode <VS Code executable> --out <folder> [--emoji-font <.ttf>]
 *
 * Opens VS Code on an empty folder with this extension and the stand-in source in test/look/source, both from their
 * folders rather than installed, and saves panel-, rows-, window- and narrow-<theme>.png for each theme in THEMES.
 * It prints each row's icon and badge, and fails if an envelope has no room left beside its title. HOME, VS Code's
 * profile and the shared folder all point under --out.
 *
 * A machine with no colour emoji font draws the envelope as a plain glyph; --emoji-font adds one, such as the Twemoji
 * font Firefox ships.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const playwright = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern' };
/* @vscode/test-electron passes the same, for the same reasons. */
const FLAGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--no-cached-data',
  '--disable-workspace-trust', '--use-inmemory-secretstorage', '--password-store=basic'];

async function until(test, ms, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await test(); } catch (_) { v = false; }
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}

const NARROW_CSS_PX = 230;

/*
 * VS Code cuts the label inside .monaco-icon-label-container and draws a decoration's badge as
 * .monaco-icon-label::after, outside that container, so an envelope stays visible as long as some width is left
 * after the container and the row ends inside the view.
 */
async function checkEnvelopes(page, view, theme, when) {
  const rows = await view.evaluate((pane) => [...pane.querySelectorAll('.monaco-list-row')].map((el) => {
    const label = el.querySelector('.monaco-icon-label');
    const box = el.querySelector('.monaco-icon-label-container');
    const name = el.querySelector('.label-name');
    const badge = label ? getComputedStyle(label, '::after').content : '';
    return { title: name ? name.textContent : '', envelope: /\u2709/.test(badge), cut: !!box && box.scrollWidth > box.clientWidth,
      room: label && box ? Math.round(label.getBoundingClientRect().right - box.getBoundingClientRect().right) : 0,
      fits: el.getBoundingClientRect().right <= pane.getBoundingClientRect().right + 0.5 };
  }).filter((r) => r.title));
  console.log(`${theme}, ${when}:\n` + rows.map((r) => `  ${r.envelope ? 'envelope' : '        '} ${r.cut ? 'cut' : '   '} room ${String(r.room).padStart(3)} ${r.title}`).join('\n'));
  const lost = rows.filter((r) => r.envelope && (r.room < 8 || !r.fits));
  if (lost.length) throw new Error(`${theme}, ${when}: no room left for the envelope on ${lost.map((r) => JSON.stringify(r.title)).join(', ')}`);
  if (/narrowed/.test(when) && !rows.some((r) => r.envelope && r.cut)) throw new Error(`${theme}, ${when}: no row with an envelope was cut short`);
}

async function shoot(exe, out, theme) {
  const run = path.join(out, 'run-' + theme);
  const dirs = { user: path.join(run, 'user'), exts: path.join(run, 'exts'), home: path.join(run, 'home'), ws: path.join(run, 'ws'), plans: path.join(run, 'plans') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(dirs.user, 'User'), { recursive: true });
  fs.writeFileSync(path.join(dirs.user, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': THEMES[theme], 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none',
    'chat.disableAIFeatures': true, 'git.enabled': false, 'agentPlus.webviewRequestLimit': 'leave', 'agentPlus.tokenMode': 'all',
  }, null, 2));
  const asked = new Date(Date.now() - 60e3).toISOString();
  fs.writeFileSync(path.join(dirs.plans, 'asks.json'), JSON.stringify({ nodes: [{ title: 'Pick the release branch', state: 'waiting', waitingOn: 'user',
    question: 'Release from main or from the hotfix branch?', asked }] }));
  fs.writeFileSync(path.join(dirs.plans, 'run.json'), JSON.stringify({ nodes: [{ title: 'Rewrite the parser', state: 'doing',
    since: new Date(Date.now() - 600e3).toISOString() }] }));
  const ready = path.join(run, 'ready.json');
  const fonts = {};
  const emoji = arg('--emoji-font');
  if (emoji) {
    const conf = path.join(run, 'fonts.conf');
    fs.writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>/usr/share/fonts</dir>`
      + `<dir>${path.dirname(path.resolve(emoji))}</dir><cachedir>${path.join(dirs.home, 'fontconfig-cache')}</cachedir></fontconfig>\n`);
    fonts.FONTCONFIG_FILE = conf;
  }
  const portFile = path.join(dirs.user, 'DevToolsActivePort');
  const env = { ...process.env, HOME: dirs.home, AGENT_WORK_PLAN_HOME: path.join(dirs.home, 'shared'), LOOK_PLANS: dirs.plans, LOOK_READY: ready,
    XDG_CONFIG_HOME: path.join(dirs.home, '.config'), XDG_CACHE_HOME: path.join(dirs.home, '.cache'), XDG_DATA_HOME: path.join(dirs.home, '.local', 'share'), ...fonts };
  for (const k of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/.test(k) || k === 'LD_LIBRARY_PATH') delete env[k];
  const log = fs.createWriteStream(path.join(run, 'vscode.log'));
  const proc = spawn(exe, [dirs.ws, ...FLAGS, `--extensions-dir=${dirs.exts}`, `--user-data-dir=${dirs.user}`, `--extensionDevelopmentPath=${ROOT}`,
    `--extensionDevelopmentPath=${path.join(__dirname, 'source')}`, '--remote-debugging-port=0', '--force-device-scale-factor=2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  let browser = null;
  try {
    const port = await until(() => { const t = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : ''; return /^\d+/.test(t) ? Number(t.split('\n')[0]) : 0; }, 90000);
    if (!port) throw new Error('VS Code wrote no DevToolsActivePort');
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => /workbench\.html/.test(p.url())), 60000);
    if (!page) throw new Error('no workbench page');
    await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
    if (!await until(() => fs.existsSync(ready), 120000)) throw new Error('the stand-in source never said it was ready');
    console.log(`${theme}: source ${fs.readFileSync(ready, 'utf8')}`);
    await page.waitForSelector('text=Stopped with a reply not read', { timeout: 60000 });
    await sleep(1500);
    const view = page.locator('.pane:has(.pane-header:has-text("Conversations"))').first();
    const rows = await page.$$eval('.monaco-list-row', (els) => els.map((el) => {
      const icon = el.querySelector('.custom-view-tree-node-item-icon');
      const label = el.querySelector('.label-name');
      return { title: label ? label.textContent : '', icon: icon ? [...icon.classList].filter((c) => c.startsWith('codicon-')).join(' ') : '',
        badge: getComputedStyle(el.querySelector('.monaco-icon-label') || el, '::after').content };
    }).filter((r) => r.title));
    console.log(`${theme}: rows\n` + rows.map((r) => `  ${r.icon.padEnd(22)} ${String(r.badge).padEnd(8)} ${r.title}`).join('\n'));
    await view.screenshot({ path: path.join(out, `panel-${theme}.png`) });
    const box = await view.boundingBox();
    await page.screenshot({ path: path.join(out, `rows-${theme}.png`), clip: { x: box.x, y: box.y, width: Math.min(box.width, 520), height: Math.min(box.height, 330) },
      scale: 'device' });
    await page.screenshot({ path: path.join(out, `window-${theme}.png`) });
    await checkEnvelopes(page, view, theme, 'as opened');
    const sash = await view.evaluate((pane) => {
      const right = pane.getBoundingClientRect().right;
      const s = [...document.querySelectorAll('.part.panel .monaco-sash.vertical')]
        .map((el) => el.getBoundingClientRect()).find((r) => r.height > 0 && Math.abs(r.left + r.width / 2 - right) < 8);
      return s ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : null;
    });
    if (!sash) throw new Error('no sash beside the Conversations view to narrow it with');
    await page.mouse.move(sash.x, sash.y);
    await page.mouse.down();
    await page.mouse.move(sash.x - (box.width - NARROW_CSS_PX), sash.y, { steps: 10 });
    await page.mouse.up();
    await sleep(800);
    await view.screenshot({ path: path.join(out, `narrow-${theme}.png`) });
    await checkEnvelopes(page, view, theme, `narrowed to ${Math.round((await view.boundingBox()).width)} px`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) { /* gone */ }
    proc.kill('SIGTERM');
    await until(() => proc.exitCode !== null || proc.signalCode !== null, 10000);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    log.end();
  }
}

(async () => {
  const exe = arg('--vscode'), out = arg('--out') ? path.resolve(arg('--out')) : '';
  if (!exe || !fs.existsSync(exe) || !out) throw new Error('usage: node test/look/conversations-panel.js --vscode <VS Code executable> --out <folder>');
  fs.mkdirSync(out, { recursive: true });
  for (const theme of Object.keys(THEMES)) await shoot(exe, out, theme);
  console.log(`pictures in ${out}`);
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
