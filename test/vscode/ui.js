// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The window stage of run.js: real VS Code windows with this extension installed from its .vsix, driven through
 * Playwright. ui-features.json lists the features and the steps that reach them; test/parts/77-ui-features.js checks the
 * two against each other and against package.json. Three windows, one after another, on one profile:
 *
 *   alone        the helper only, so nothing uses Agent Plus: no view, no status bar entry, one notice
 *   main         the helper and the stand-in source in source/, through which each step makes the conversations it
 *                needs: the first-install notices, the request limit, the Conversations view's dots, envelopes and
 *                rows, the Answer view, briefs, the Work plan view, notifications and their count, the token mode,
 *                the view settings and Show Status
 *   restricted   the same two in Restricted Mode
 *
 * The feature list check reads three helpers in each step: setting() and exec(), and viaUi(), which names the command
 * a click in the window runs. Every look() saves a screenshot to <out>/shots; with --look each also writes a close view
 * and an entry of <out>/look.json.
 *
 * AGENT_PLUS_UI_STEPS, a regular expression, runs only the steps whose names match it, together with the steps they
 * name in their needs('…') calls, followed through (lib/steps.js); when a step it needs did not finish, the step fails
 * and names it. A step with a failed check keeps a screenshot, and the window's HTML and text in <out>/state/.
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const steps = require('./lib/steps');
const pixels = require('./lib/pixels');

const { sleep, until } = win;
const SOURCE = path.join(__dirname, 'source');
const FEATURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-features.json'), 'utf8'));
const LOOK_SETTINGS = {};
const SCALE = 2;
/* src/envelope.js: 📩 in dark themes, the plain envelope's text form in light ones. */
const COLOUR = '\u{1F4E9}', TEXT = '\u2709\uFE0E';
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', hcDark: 'Default High Contrast', hcLight: 'Default High Contrast Light' };
const SW = 'out/vs/workbench/contrib/webview/browser/pre/service-worker.js';
const HOUR = 3600e3;
const ASK_TOKEN = 'Some features add text to the agent\'s context and use tokens.';
const ASK_LIMIT = 'VS Code lets webview tabs';
const ALONE = 'Agent Plus is used by Claude Code Plus and Codex Plus, which install it themselves.';
const LONG = 'A long title that is cut short in a narrow panel, while the envelope at the end of the row stays in view';
const Q1 = 'Release from main or from the hotfix branch?';
const Q2 = 'Should the log keep JSON lines or plain text?';
/* What Agent Plus's tooltip lists for the five features, in the order of FEATURES in src/token-mode.js. */
const ALL_FEATURES = ['work plan', 'time-zone note', 'conversation brief', 'wake-ups', 'notices when a detached command stops'];
const CODEX_SWITCHES = ['codexPlus.workPlan', 'codexPlus.tellCodexYourTimeZone', 'codexPlus.conversationBrief', 'codexPlus.wakeUps',
  'codexPlus.detachedEndNotices'];

/* How the aria-labels of the session list's and the Work plan's activity bar entries start; the session list's
   container is titled Agent Plus - Conversations. */
const SESSIONS_ENTRY = '^Agent Plus - Conversations', PLAN_ENTRY = '^Agent Plus(?! - Conversations)';
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function run({ exe, profile, env, playwright, out, check: report, note, look: looking }) {
  let failedChecks = 0;
  const check = (cond, what, detail) => { const ok = report(cond, what, detail); if (!ok) failedChecks++; return ok; };
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const linux = process.platform === 'linux';
  let w = null, page = null, call = null, launchedAt = 0;
  const picked = steps.chosen({ names: steps.namesIn(__filename), only: process.env.AGENT_PLUS_UI_STEPS ? new RegExp(process.env.AGENT_PLUS_UI_STEPS) : null,
    needs: steps.needsIn(__filename) });
  const done = new Set();
  let current = '';
  /*
   * Kept in <out>/state/<step>/ when a step fails: the workbench's HTML, the text of each frame in it (the webviews of
   * Agent Plus's views among them) with their addresses, and the notifications shown.
   */
  const keepState = async (name) => {
    const dir = path.join(out, 'state', name.replace(/[^\w.-]+/g, '-').slice(0, 80));
    try {
      fs.mkdirSync(dir, { recursive: true });
      const frames = [];
      for (const [i, f] of page.frames().entries()) {
        const html = await f.content().catch(() => '');
        const text = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        if (html) fs.writeFileSync(path.join(dir, `frame-${i}.html`), html.slice(0, 4 << 20));
        frames.push({ frame: i, url: f.url().slice(0, 300), name: f.name(), text: text.slice(0, 20000) });
      }
      const notifications = await page.evaluate(() => [...document.querySelectorAll('.notification-list-item-message')].map((e) => e.innerText)).catch((e) => String(e));
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ step: name, at: new Date().toISOString(), notifications, frames }, null, 2) + '\n');
    } catch (e) { note(`${name}: the window's state could not be kept: ${(e && e.message) || e}`); }
  };
  const step = async (name, fn) => {
    if (picked && !picked.has(name)) return;
    console.log(`\n── ${name}`);
    current = name;
    const failedBefore = failedChecks;
    try { await fn(); done.add(name); } catch (e) {
      check(false, `${name}: ran to its end`, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
    }
    if (failedChecks > failedBefore && page) {
      await page.screenshot({ path: path.join(shotsDir, `failed-${name}.png`) }).catch(() => {});
      await keepState(name);
    }
  };
  const needs = (name) => { if (!done.has(name)) throw new Error(`this step needs the step ${name}, which did not run to its end`); };
  const viaUi = async (command, act) => { console.log(`  ui    ${command}`); return act(); };

  /* ── opening and closing windows ── */
  const open = async (label, dev, opts = {}) => {
    launchedAt = Date.now();
    w = await win.open({ exe, profile, env, playwright, log: path.join(out, `vscode-${label}.log`), dev,
      args: looking ? [`--force-device-scale-factor=${SCALE}`] : [], ...opts });
    page = w.page;
    call = w.call;
    await w.hostUp();
    await page.mouse.move(5, 5);
  };
  const shut = async () => { if (w) await w.close(); w = null; };
  const writeSettings = (more) => {
    const file = path.join(profile.user, 'User', 'settings.json');
    fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), more), null, 2));
  };

  /* ── the vscode API, through the helper ── */
  const exec = (command, ...a) => call(`await vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  /* Not awaited: the command opens a list or dialog that the step then answers in the window. */
  const start = (command, ...a) => call(`vscode.commands.executeCommand(${JSON.stringify(command)}, ...arg); return true;`, a);
  /* Sets `key` (section.name) in the user settings; undefined removes it. */
  const setting = (key, value) => call(`const i = arg[0].indexOf('.');
    await vscode.workspace.getConfiguration(arg[0].slice(0, i)).update(arg[0].slice(i + 1), arg[1] === null ? undefined : arg[1], vscode.ConfigurationTarget.Global);
    return true;`, [key, value === undefined ? null : value]);
  const userValue = (key) => call(`const i = arg.indexOf('.'); const v = vscode.workspace.getConfiguration(arg.slice(0, i)).inspect(arg.slice(i + 1));
    return v && v.globalValue !== undefined ? v.globalValue : null;`, key);
  const theme = (name) => call(`await vscode.workspace.getConfiguration('workbench').update('colorTheme', arg, vscode.ConfigurationTarget.Global); return true;`, name);
  const openNotes = () => call(`await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(path.join(profile.folder, 'notes.txt'))}), { preview: false }); return true;`);
  const tabs = () => call(`return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive && g.isActive,
    view: (t.input && t.input.viewType) || '', file: (t.input && t.input.uri && t.input.uri.fsPath) || '' })));`);
  const frontTab = async () => (await tabs()).find((t) => t.active) || null;
  const frontIs = (label) => until(async () => { const t = await frontTab(); return t && t.label === label && t; }, 15000, 300);
  const focused = () => call('return vscode.window.state.focused === true;');
  const SRC = 'const ext = vscode.extensions.getExtension("xnervwang.codex-plus"); if (!ext.isActive) await ext.activate(); const src = ext.exports;';
  const src = (body, arg) => call(`${SRC} ${body}`, arg);
  const conversations = (list) => src('return src.set(arg);', list);
  const patch = (id, fields) => src('return src.patch(arg[0], arg[1]);', [id, fields]);
  const openConv = (id) => src('return src.open(arg);', id);
  const conv = (sessionId, title, state, activity, unseen = false, more = {}) => Object.assign({ sessionId, title, state, activity, unseen,
    running: true, lastActiveAt: Date.now(), lastUserAt: Date.now() - HOUR }, more);
  const writePlan = (id, plan) => fs.writeFileSync(path.join(profile.plans, `${id}.json`), JSON.stringify(plan, null, 2) + '\n');
  let appRoot = '';
  const swLimit = () => {
    try { const m = /maxActiveHostResourceResponseBodies=(\d+),/.exec(fs.readFileSync(path.join(appRoot, SW), 'utf8')); return m ? Number(m[1]) : null; } catch (_) { return null; }
  };

  const themeColor = (name) => page.evaluate((v) => {
    const e = document.createElement('div');
    e.style.color = `var(--vscode-${v.replace(/\./g, '-')})`;
    document.querySelector('.monaco-workbench').appendChild(e);
    const c = getComputedStyle(e).color;
    e.remove();
    return c;
  }, name);
  /* How the aria-label of each view's pane header starts; a pane is found by it. */
  const HEADERS = { 'agentPlus.conversations': 'Conversations Section', 'agentPlus.answer': 'Answer Section', 'agentPlus.workPlan': 'Work plan' };
  const treeRows = (view) => page.evaluate((h) => {
    const pane = [...document.querySelectorAll('.pane')].find((p) => { const x = p.querySelector(':scope > .pane-header'); return x && (x.getAttribute('aria-label') || '').startsWith(h)
      && !p.closest('[id="workbench.view.extension.agentPlusSessions"]'); });
    if (!pane || !pane.offsetParent) return null;
    const view = pane.getBoundingClientRect();
    return [...pane.querySelectorAll('.monaco-list-row')].map((el) => {
      const label = el.querySelector('.monaco-icon-label');
      const icon = el.querySelector('.custom-view-tree-node-item-icon');
      const box = el.querySelector('.monaco-icon-label-container');
      const after = label ? getComputedStyle(label, '::after').content : '';
      return { title: ((el.querySelector('.label-name') || {}).textContent || '').trim(),
        description: ((el.querySelector('.label-description') || {}).textContent || '').trim(),
        level: Number(el.getAttribute('aria-level')), expanded: el.getAttribute('aria-expanded'),
        icon: icon ? [...icon.classList].filter((c) => /^codicon-/.test(c) && c !== 'codicon-colored').join(' ') : '',
        image: icon ? getComputedStyle(icon).backgroundImage : '', color: icon ? icon.style.color : '',
        badge: after && !/^(none|normal)$/.test(after) ? after.replace(/^"|"$/g, '') : '',
        cut: !!box && box.scrollWidth > box.clientWidth,
        room: label && box ? Math.round(label.getBoundingClientRect().right - box.getBoundingClientRect().right) : 0,
        fits: el.getBoundingClientRect().right <= view.right + 0.5,
        aria: el.getAttribute('aria-label') || '' };
    }).filter((r) => r.title);
  }, HEADERS[view]);
  const convRows = () => treeRows('agentPlus.conversations');
  const planRows = () => treeRows('agentPlus.workPlan');
  const convRow = async (title) => (await convRows() || []).find((r) => r.title === title) || null;
  /* The part of the window each view is in, as the session list's view in the side bar is titled Conversations too. */
  const SCOPES = { 'agentPlus.workPlan': '[id="workbench.view.extension.agentPlus"]', 'agentPlus.conversations': '[id="workbench.parts.panel"]',
    'agentPlus.answer': '[id="workbench.parts.panel"]' };
  const pane = (view) => page.locator(`${SCOPES[view] || ''} .pane:has(> .pane-header[aria-label^="${HEADERS[view]}"])`).first();
  const rowLoc = (view, title) => pane(view).locator('.monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRe(title)}$`) }) }).first();
  /* A window that opens small, as on the macOS and Windows runners, has a panel too short for every row: the tree draws
     only the rows in view, so the panel is maximized there. */
  const showConversations = async () => {
    await exec('agentPlus.conversations.focus');
    await sleep(300);
    const small = await page.evaluate(() => innerHeight < 850);
    const maximized = await page.evaluate(() => { const e = document.getElementById('workbench.parts.editor'); return !e || e.offsetHeight < 40; });
    if (small && !maximized) { await exec('workbench.action.toggleMaximizedPanel'); await sleep(500); }
  };
  /* When the row is not drawn inside the list's visible box, this scrolls the list from the top a step at a time until
     it is, since the tree scrolls itself and Playwright cannot bring such a row into view on its own. The pointer is
     moved off the trees first, as the hover box of a row the previous step pointed at can cover this one. */
  const clickRow = async (view, title, opts) => {
    if (view === 'agentPlus.conversations') await showConversations();
    await clearToasts();
    await unhover();
    const row = rowLoc(view, title), list = pane(view).locator('.monaco-list').first();
    const shown = async () => {
      if (!await row.count()) return false;
      const [r, l] = await Promise.all([row.boundingBox().catch(() => null), list.boundingBox().catch(() => null)]);
      return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
    };
    if (!await shown()) {
      await list.hover().catch(() => {});
      await page.mouse.wheel(0, -5000);
      await sleep(150);
      for (let i = 0; i < 20 && !await shown(); i++) { await page.mouse.wheel(0, 60); await sleep(150); }
      await unhover();
    }
    return row.click(opts);
  };
  const showPlanView = async () => { await exec('workbench.view.extension.agentPlus'); await sleep(500); };
  /* Drags the edge of the side bar until it is about `want` CSS pixels wide, or as close to that as the window allows. */
  const sideBarWidth = async (want) => {
    const edge = await page.evaluate(() => {
      const b = document.getElementById('workbench.parts.sidebar').getBoundingClientRect();
      const s = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect())
        .find((r) => r.height > 100 && Math.abs((r.left + r.right) / 2 - b.right) < 4);
      return s && { x: (s.left + s.right) / 2, y: b.top + b.height / 2, width: b.width, room: innerWidth - 500 };
    });
    if (!edge) return;
    const to = Math.min(want, edge.room);
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.down();
    await page.mouse.move(edge.x + (to - edge.width), edge.y, { steps: 10 });
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await sleep(500);
  };
  const welcome = (view) => page.evaluate((h) => {
    const p = [...document.querySelectorAll('.pane')].find((x) => { const y = x.querySelector(':scope > .pane-header'); return y && (y.getAttribute('aria-label') || '').startsWith(h)
      && !x.closest('[id="workbench.view.extension.agentPlusSessions"]'); });
    const m = p && p.querySelector('.welcome-view-content');
    return m && m.offsetParent ? m.innerText.trim() : '';
  }, HEADERS[view]);

  const entry = (name) => page.evaluate((id) => {
    const e = document.getElementById(`xnervwang.agent-plus.agentPlus.${id}`);
    return e && e.offsetParent ? { text: e.innerText.trim(), label: e.getAttribute('aria-label') || '', warning: e.classList.contains('warning-kind'),
      error: e.classList.contains('error-kind') } : null;
  }, name);
  const entryLoc = (name) => page.locator(`[id="xnervwang.agent-plus.agentPlus.${name}"]`);
  /* The N of the Conversations entry's "N conversations need you", or 0. */
  const bell = async () => { const e = await entry('conversations'); const m = e && /(\d+) conversations? needs? you/.exec(e.text); return m ? Number(m[1]) : 0; };
  const anyHover = () => page.evaluate(() => !![...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim()));
  const hoverText = async (loc) => {
    await page.mouse.move(5, 5);
    await until(async () => !await anyHover(), 3000, 200);
    await sleep(300);
    await loc.hover();
    const text = await until(() => page.evaluate(() => {
      const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim());
      return h ? h.innerText.trim() : '';
    }), 6000, 200);
    return text || '';
  };
  const unhover = async () => { await page.mouse.move(5, 5); await sleep(300); };

  /* The notifications on screen, each with its message and its buttons' labels. */
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].filter((e) => e.offsetParent !== null).map((e) => ({
    text: ((e.querySelector('.notification-list-item-message') || e).innerText || '').trim(),
    buttons: [...e.querySelectorAll('.notification-list-item-buttons-container .monaco-button')].map((b) => b.innerText.trim()) })));
  const toastWith = (text, ms = 15000) => until(async () => (await toasts()).find((t) => t.text.includes(text)) || null, ms, 250);
  const noToast = async (text, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await toasts()).some((t) => t.text.includes(text))) return false; await sleep(250); }
    return true;
  };
  const toastLoc = (text) => page.locator('.notification-toast').filter({ hasText: text }).first();
  const press = (text, button) => toastLoc(text).locator('.notification-list-item-buttons-container .monaco-button')
    .filter({ hasText: new RegExp(`^${escapeRe(button)}$`) }).first().click({ timeout: 10000 });
  /* A notification stays on screen while the pointer is over it, over the status bar's right end and the Answer view's
     buttons, so notifications are cleared before a click there. */
  const clearToasts = async () => { await exec('notifications.clearAll'); await sleep(300); };
  /* A notification's time (src/notice-time.js): [HH:MM] in the reader's zone, [HH:MM ZONE] before it is known. VS Code
     runs on this machine, so the hour and minute are this machine's either way; the check takes this minute or the
     one before. */
  const STAMP = /^\[(\d\d:\d\d)( [^\]]+)?\] /;
  const hourMinute = (ms) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const stampOf = (text) => { const m = STAMP.exec(text || ''); return m ? { time: m[1], zone: (m[2] || '').trim() } : null; };
  const isNow = (time) => [Date.now(), Date.now() - 60000].map(hourMinute).includes(time);

  const pickRows = () => until(async () => {
    const rows = await page.evaluate(() => {
      const w = document.querySelector('.quick-input-widget');
      if (!w || !w.offsetParent) return null;
      return [...w.querySelectorAll('.quick-input-list .monaco-list-row')].map((r) => ({ text: r.innerText.replace(/\s+/g, ' ').trim(),
        label: ((r.querySelector('.label-name') || r.querySelector('.monaco-icon-label') || {}).textContent || '').trim(),
        active: r.classList.contains('focused') }));
    });
    return rows && rows.length ? rows : null;
  }, 10000, 250);
  const pick = (label) => page.locator('.quick-input-widget .quick-input-list .monaco-list-row').filter({ hasText: label }).first().click({ timeout: 10000 });
  const dialog = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('.monaco-dialog-box')].find((e) => e.offsetParent);
    return d ? { text: d.innerText.trim(), buttons: [...d.querySelectorAll('.dialog-buttons .monaco-button')].map((b) => b.innerText.trim()) } : null;
  });

  /* ── the look run ── */
  const entries = [];
  let previous = null, lookNo = 0, logAt = new Map();
  const cut = (png, clip) => {
    const img = pixels.decode(png);
    const x0 = Math.round(clip.x * SCALE), y0 = Math.round(clip.y * SCALE);
    const wd = Math.min(img.width - x0, Math.round(clip.width * SCALE)), ht = Math.min(img.height - y0, Math.round(clip.height * SCALE));
    if (wd < 1 || ht < 1) throw new Error('the close view lies outside the screenshot');
    const data = Buffer.alloc(wd * ht * 4);
    for (let y = 0; y < ht; y++) img.data.copy(data, y * wd * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + wd) * 4);
    return pixels.encode({ width: wd, height: ht, data });
  };
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((n) => (n.isDirectory() ? walk(path.join(d, n.name)) : [path.join(d, n.name)])); } catch (_) { return []; } };
  /* The lines Agent Plus and the extension host logged since the last picture. */
  const newLogLines = () => {
    const lines = [];
    for (const f of walk(path.join(profile.user, 'logs')).filter((x) => /(Agent Plus\.log|exthost\.log)$/.test(x))) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const from = logAt.get(f) || 0;
      logAt.set(f, text.length);
      lines.push(...text.slice(from).split('\n').filter((l) => l.trim()).slice(-40).map((l) => `[${path.basename(f)}] ${l}`));
    }
    return lines;
  };
  /*
   * A picture of the step's state. `target` is a locator or a box in CSS pixels for the close view, or null for the whole
   * window. Outside --look it saves the whole window only. First the pointer is moved off, unless spec.pointer is set
   * for a picture of a hover, and the notifications are cleared, unless spec.toasts is set for a picture of one.
   */
  const look = async (name, spec, target = null) => {
    if (!spec.pointer) await page.mouse.move(5, 5);
    if (!spec.toasts) await clearToasts();
    await sleep(300);
    const n = String(++lookNo).padStart(2, '0');
    const full = `shots/${n}-${name}-full.png`, image = `shots/${n}-${name}.png`;
    const png = await page.screenshot({ animations: 'disabled' }).catch(() => null);
    if (png) fs.writeFileSync(path.join(out, full), png);
    if (!looking) return;
    const said = [];
    let box = null;
    try { box = target && typeof target.boundingBox === 'function' ? await target.boundingBox() : target; } catch (e) { said.push(`[ui] no box for the close view: ${e.message}`); }
    let made = false;
    if (box && png) {
      const pad = 6;
      const vp = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
      const clip = { x, y, width: Math.min(vp.width, Math.ceil(box.x + box.width + pad)) - x, height: Math.min(vp.height, Math.ceil(box.y + box.height + pad)) - y };
      try { if (clip.width >= 4 && clip.height >= 4) { fs.writeFileSync(path.join(out, image), cut(png, clip)); made = true; } } catch (e) { said.push(`[ui] ${e.message}`); }
    }
    if (!made && png) fs.copyFileSync(path.join(out, full), path.join(out, image));
    const size = (() => { try { const b = fs.readFileSync(path.join(out, image)); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; } catch (_) { return null; } })();
    const toastsNow = (await toasts().catch(() => [])).map((t) => `[notification on screen] ${t.text}${t.buttons.length ? ` [${t.buttons.join('] [')}]` : ''}`);
    entries.push({ name, features: FEATURES.filter((f) => f.looks.includes(name)).map((f) => f.id), expect: spec.expect, unchanged: spec.unchanged || null,
      image, full, previous, width: size ? size.width : null, height: size ? size.height : null, log: [...said, ...newLogLines(), ...toastsNow],
      ...(spec.note ? { note: spec.note } : {}) });
    previous = full;
    fs.writeFileSync(path.join(out, 'look.json'), JSON.stringify(entries, null, 2));
  };

  /* ═══ alone: nothing uses Agent Plus ═══ */
  await open('alone', []);
  await step('alone', async () => {
    const notice = await toastWith(ALONE, 30000);
    check(!!notice && sameList(notice.buttons, ['Install Claude Code Plus', 'Install Codex Plus']),
      'installed with no extension that uses it, Agent Plus shows one notice with a button to install each extension that would', notice || await toasts());
    const first = stampOf(notice && notice.text);
    check(!!first && isNow(first.time) && !!first.zone, 'it starts with the time and names this machine\'s zone, since no page has reported the reader\'s zone yet', notice && notice.text);
    const ours = await page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter((e) => e.offsetParent && /^xnervwang\.agent-plus\./.test(e.id)).map((e) => e.id));
    check(!ours.length, 'it shows no status bar entry', ours);
    const bar = await page.evaluate(() => [...document.querySelectorAll('.activitybar .action-item .action-label')].map((a) => a.getAttribute('aria-label') || '')
      .filter((t) => /^Agent Plus/.test(t)));
    check(!bar.length, 'and no Agent Plus in the activity bar', bar);
    const panelTabs = await page.evaluate(() => [...document.querySelectorAll('.part.panel .composite-bar .action-label')].map((a) => (a.getAttribute('aria-label') || a.innerText || '').trim()));
    check(!panelTabs.some((t) => /^Conversations/.test(t)), 'and no Conversations tab in the panel', panelTabs);
    await look('alone-notice', { toasts: true, expect: 'A notification at the bottom right saying that Agent Plus is used by Claude Code Plus and Codex Plus, which install it themselves, and does nothing on its own, with the buttons Install Claude Code Plus and Install Codex Plus. No Agent Plus icon in the activity bar on the left, and no Conversations, bell or token mode entry in the status bar.' },
      toastLoc(ALONE));
  });
  await shut();

  /* ═══ main: the stand-in source ═══ */
  await open('main', [SOURCE]);
  appRoot = await call('return vscode.env.appRoot;');

  await step('first-start', async () => {
    const r = await src('return src.result;');
    check(!!r && r.accepted, 'the stand-in source is registered with Agent Plus', r);
    const ask = await toastWith(ASK_TOKEN, 30000);
    check(!!ask && sameList(ask.buttons, ['Choose a Mode...', 'Learn More']),
      'on a first install with an extension that uses it, a notice asks for a token mode, with one button for the list and one to learn more', ask || await toasts());
    await look('token-mode-first-notice', { toasts: true, expect: 'A notification saying that some features add text to the agent\'s context and use tokens, asking which Claude Code Plus and Codex Plus features run, with the buttons Choose a Mode... and Learn More. No other button, and no text cut off.' },
      toastLoc(ASK_TOKEN));
    await press(ASK_TOKEN, 'Choose a Mode...');
    const rows = await pickRows();
    check(!!rows && sameList(rows.map((x) => x.label), ['Interface features', 'Essential features', 'All features', 'Custom']),
      'its button opens the list of the four modes', rows);
    check(!!rows && /current/.test((rows.find((x) => x.label === 'All features') || {}).text || ''), 'with All features marked as the current one', rows);
    await pick('All features');
    check(await until(async () => (await userValue('agentPlus.tokenMode')) === 'all', 5000), 'choosing All features there writes it as the mode', await userValue('agentPlus.tokenMode'));

    check(swLimit() === 32, 'VS Code\'s service-worker.js starts with the request limit at 32', { appRoot, limit: swLimit() });
    const lim = await toastWith(ASK_LIMIT, 30000);
    const want = linux ? ['Raise it this time', 'Leave it'] : ['Raise it, now and after updates', 'Raise it this time', 'Leave it'];
    check(!!lim && sameList(lim.buttons, want), `with agentPlus.webviewRequestLimit at ask, a notice asks whether to raise VS Code's request limit, with ${want.join(', ')}`, lim || await toasts());
    if (lim && linux) check(/too many open files can crash a window/.test(lim.text), 'on Linux it says why VS Code has the limit there', lim.text);
    await look('request-limit-notice', { toasts: true, expect: `A notification asking whether to raise the limit on requests in flight for webview tabs to 1000000 in VS Code's own files, with the buttons ${want.join(', ')}. ${linux ? 'It also says VS Code added the limit for Linux, where too many open files can crash a window. ' : ''}No text cut off.` },
      toastLoc(ASK_LIMIT));
    await press(ASK_LIMIT, 'Raise it this time');
    check(!!await until(() => swLimit() === 1000000, 20000, 250), 'Raise it this time raises the limit to 1000000 in VS Code\'s service-worker.js', swLimit());
    const said = await toastWith('request limit is now 1000000', 15000);
    check(!!said && /Quit and reopen VS Code/.test(said.text), 'and says to quit and reopen VS Code for it to apply', said || await toasts());
    check(await userValue('agentPlus.webviewRequestLimit') === null, 'and leaves the setting at ask, so the next VS Code build is asked about again');
  });

  await step('request-limit', async () => {
    needs('first-start');
    await clearToasts();
    await exec('agentPlus.restoreWebviewRequestLimit');
    check(swLimit() === 32, 'Put Back VS Code\'s Request Limit returns it to 32', swLimit());
    const back = await toastWith('request limit is back to 32', 10000);
    check(!!back, 'and says so', back || await toasts());
    check(await userValue('agentPlus.webviewRequestLimit') === 'leave', 'and sets agentPlus.webviewRequestLimit to leave, so nothing raises it again');
    await clearToasts();
    await exec('agentPlus.restoreWebviewRequestLimit');
    check(!!await toastWith('request limit is already 32', 10000), 'run again, it says the limit is already 32', await toasts());
    await clearToasts();
    await setting('agentPlus.webviewRequestLimit', 'raise');
    if (linux) {
      check(await noToast(ASK_LIMIT, 6000) && swLimit() === 32, 'on Linux, with raise the limit is not raised without asking, and a build already asked about is not asked about again', swLimit());
    } else {
      check(!!await until(() => swLimit() === 1000000, 20000, 250), `on ${process.platform}, raise raises the limit at once`, swLimit());
      check(await noToast(ASK_LIMIT, 1000), 'without asking');
      check(!!await toastWith('request limit is now 1000000', 10000), 'and says it is now 1000000', await toasts());
      await exec('agentPlus.restoreWebviewRequestLimit');
      check(swLimit() === 32, 'and putting it back returns it to 32 again', swLimit());
    }
    await setting('agentPlus.webviewRequestLimit', 'leave');
    await sleep(1500);
    check(swLimit() === 32 && await noToast(ASK_LIMIT, 1500), 'with leave, the file is left alone', swLimit());
    await clearToasts();
  });

  /* ── the Conversations view ── */
  const DOTS = [
    ['run', 'Running a turn', 'working', 'working', false],
    ['run-new', 'Running, with a reply not read yet', 'working', 'working', true],
    ['bg', 'Only background work left', 'working', 'background', false],
    ['bg-new', 'Background work, reply not read', 'working', 'background', true],
    ['prompt', 'At a permission prompt', 'prompt', 'waiting', false],
    ['done', 'Stopped, nothing new', 'idle', 'stopped', false],
    ['done-new', 'Stopped with a reply not read', 'unread', 'stopped', true],
    ['long', LONG, 'unread', 'stopped', true],
  ];
  const LOOK_OF = { working: ['codicon-circle-filled', 'charts.green'], background: ['codicon-circle', 'charts.green'], waiting: ['codicon-circle-filled', 'charts.blue'],
    stopped: ['codicon-blank', ''] };
  const WORDS = { working: 'Running a turn', background: 'Turn over, only background work running', waiting: 'Waiting for you', stopped: 'Stopped' };
  /* Checks the icon, colour and envelope of each row of DOTS; `glyph` is the envelope the theme should draw. */
  const dotsWrong = async (glyph) => {
    const rows = await convRows() || [];
    const colors = { 'charts.green': await themeColor('charts.green'), 'charts.blue': await themeColor('charts.blue') };
    const wrong = [];
    for (const [, title, , activity, unseen] of DOTS) {
      const r = rows.find((x) => x.title === title);
      if (!r) { wrong.push({ title, missing: true }); continue; }
      const [icon, color] = LOOK_OF[activity];
      const bad = [];
      if (r.icon !== icon) bad.push(`icon ${r.icon}, want ${icon}`);
      if ((color ? colors[color] : '') !== r.color) bad.push(`colour ${r.color || 'none'}, want ${color ? colors[color] : 'none'}`);
      if (unseen ? r.badge !== glyph : r.badge) bad.push(`envelope ${JSON.stringify(r.badge)}, want ${unseen ? JSON.stringify(glyph) : 'none'}`);
      if (!r.aria.includes(WORDS[activity]) || r.aria.includes('Has a reply you have not read') !== unseen) bad.push('the tooltip does not say its activity and whether a reply is unread');
      if (bad.length) wrong.push({ title, bad });
    }
    return wrong;
  };

  await step('notice-time', async () => {
    needs('request-limit');
    /* The Answer view's page runs on the reader's machine and reports its time zone. */
    await exec('agentPlus.answer.focus');
    let last = '';
    const said = await until(async () => {
      await clearToasts();
      await exec('agentPlus.showAttention');
      const t = await toastWith('No conversation needs you now.', 5000);
      last = t ? t.text : '';
      const s = stampOf(last);
      return s && !s.zone && last;
    }, 20000, 500);
    const s = stampOf(said || last);
    check(!!said && isNow(s.time) && said.endsWith('] No conversation needs you now.'),
      'once a page has reported the reader\'s zone, a notification starts with the hour and minute there and names no zone', last);
    await look('notice-time', { toasts: true, expect: 'A notification at the bottom right with the time in square brackets before its text, No conversation needs you now. The time is two-digit hours and minutes, such as [14:05], with nothing else in the brackets, and the text is not cut off.' },
      toastLoc('No conversation needs you now.'));
    await clearToasts();
  });

  await step('conversation-dots', async () => {
    await openNotes();
    await conversations(DOTS.map(([id, title, state, activity, unseen]) => conv(id, title, state, activity, unseen)));
    await showConversations();
    const listed = await until(async () => { const r = await convRows(); return r && DOTS.every(([, t]) => r.some((x) => x.title === t)) && r; }, 20000, 300);
    check(!!listed, `the Conversations view lists the ${DOTS.length} conversations of the stand-in source`, await convRows());
    const wrong = await until(async () => { const x = await dotsWrong(COLOUR); return x.length ? null : x; }, 10000, 500) || await dotsWrong(COLOUR);
    check(!wrong.length, 'each row\'s icon says its activity: a green dot running a turn, a green ring with only background work left, a blue dot at a permission prompt, none stopped; and the dark theme\'s envelope ends each row with a reply not read, and no other', wrong);
    const run = await convRow('Running a turn');
    check(!!run && /working · no work plan/.test(run.description), 'a row\'s description says its state and that it keeps no work plan', run && run.description);
    await look('conversation-dots', { expect: 'The Conversations view in the panel lists eight conversations. Running a turn and Running, with a reply not read yet have a filled green dot; Only background work left and Background work, reply not read have a hollow green ring; At a permission prompt has a filled blue dot; Stopped with a reply not read, Stopped, nothing new and the row with the long title have no dot, their titles lined up with the others. An envelope ends the rows Running, with a reply not read yet; Background work, reply not read; Stopped with a reply not read; and the long one, and no other row. No red dot anywhere.' },
      pane('agentPlus.conversations'));
  });

  await step('envelope-read', async () => {
    needs('conversation-dots');
    await openConv('done-new');
    await frontIs('Stopped with a reply not read');
    /* Opening an editor gives a maximized panel its height back. */
    await showConversations();
    const gone = await until(async () => { const r = await convRow('Stopped with a reply not read'); return r && !r.badge && r; }, 15000, 300);
    check(!!gone, 'opening a conversation with a reply not read takes the envelope off its row', await convRow('Stopped with a reply not read'));
    const others = (await convRows() || []).filter((r) => r.badge).map((r) => r.title);
    check(sameList(others.sort(), ['Background work, reply not read', LONG, 'Running, with a reply not read yet'].sort()), 'and leaves the others\' envelopes', others);
    await look('envelope-read', { expect: 'The same eight rows. Stopped with a reply not read now has no envelope and no dot, and reads idle; Running, with a reply not read yet, Background work, reply not read and the long-titled row still end with an envelope.' },
      pane('agentPlus.conversations'));
    await patch('done-new', { unseen: true, state: 'unread' });
    await openNotes();
  });

  await step('envelope-themes', async () => {
    needs('conversation-dots');
    await showConversations();
    const inTheme = async (name, glyph) => {
      await theme(name);
      const wrong = await until(async () => { const x = await dotsWrong(glyph); return x.length ? null : x; }, 15000, 500) || await dotsWrong(glyph);
      check(!wrong.length, `in ${name} each row with a reply not read ends with the envelope ${glyph}, and the dots take that theme's green and red`, wrong);
    };
    const said = (name, glyph) => ({ expect: `The Conversations view in the ${name} theme. The four rows with a reply not read end with an envelope (Stopped with a reply not read has one again, as the script marked it unread after the step before), drawn ${name !== THEMES.dark
      ? 'as a plain envelope in a dark outline, easy to see on the light background, not a white or faint emoji'
      : 'as the envelope with a downward arrow, in colour where the machine has a colour emoji font, and otherwise as an outline: the text is the character the window test checks'}; the dots are the theme's green and red, filled for running and waiting, hollow for only background work left, and the stopped rows have none.` });
    await inTheme(THEMES.light, TEXT);
    await look('envelope-light', said(THEMES.light, TEXT), pane('agentPlus.conversations'));
    await inTheme(THEMES.hcLight, TEXT);
    await look('envelope-high-contrast-light', said(THEMES.hcLight, TEXT), pane('agentPlus.conversations'));
    await inTheme(THEMES.dark, COLOUR);
    await look('envelope-dark', said(THEMES.dark, COLOUR), pane('agentPlus.conversations'));
  });

  await step('narrow-panel', async () => {
    needs('conversation-dots');
    await showConversations();
    const view = pane('agentPlus.conversations');
    const box = await view.boundingBox();
    const sash = await view.evaluate((p) => {
      const right = p.getBoundingClientRect().right;
      const s = [...document.querySelectorAll('.part.panel .monaco-sash.vertical')].map((el) => el.getBoundingClientRect())
        .find((r) => r.height > 0 && Math.abs(r.left + r.width / 2 - right) < 8);
      return s ? { x: s.left + s.width / 2, y: s.top + s.height / 2 } : null;
    });
    if (!sash) throw new Error('no sash beside the Conversations view to narrow it with');
    await page.mouse.move(sash.x, sash.y);
    await page.mouse.down();
    await page.mouse.move(sash.x - (box.width - 230), sash.y, { steps: 10 });
    await page.mouse.up();
    await sleep(800);
    const width = Math.round((await view.boundingBox()).width);
    const long = await convRow(LONG);
    check(!!long && long.cut && long.badge === COLOUR && long.room >= 8 && long.fits,
      `narrowed to ${width} px, the long title is cut short and its envelope stays whole at the row's end`, long);
    const lost = (await convRows() || []).filter((r) => r.badge && (r.room < 8 || !r.fits)).map((r) => r.title);
    check(!lost.length, 'and no other row\'s envelope loses its room', lost);
    await look('narrow-panel', { expect: 'The Conversations view, narrowed to about 230 pixels. The long title ends in an ellipsis, and after it the envelope is drawn whole, inside the view. The other rows with an envelope keep theirs whole too.' }, view);
    await page.mouse.move(sash.x - (box.width - 230), sash.y);
    await page.mouse.down();
    await page.mouse.move(sash.x, sash.y, { steps: 10 });
    await page.mouse.up();
    await sleep(500);
  });

  await step('stopped-group', async () => {
    writePlan('paused', { nodes: [{ title: 'Port the importer', state: 'todo' }, { title: 'Write the notes', state: 'done' }] });
    await conversations([conv('run', 'Running a turn', 'working', 'working'), conv('paused', 'Paused for the night', 'idle', 'stopped', false, { running: false })]);
    await showConversations();
    const group = await until(async () => (await convRows() || []).find((r) => /^Not running, with open rows \(1\)$/.test(r.title)), 15000, 300);
    check(!!group && group.icon === 'codicon-history' && group.expanded === 'false', 'a stopped conversation with open rows is listed under Not running, with open rows (1), folded', group);
    await clearToasts();
    await rowLoc('agentPlus.conversations', 'Not running, with open rows (1)').locator('.monaco-tl-twistie').click();
    const child = await until(async () => (await convRows() || []).find((r) => r.title === 'Paused for the night'), 10000, 300);
    check(!!child && child.level === 2 && child.icon === 'codicon-blank' && /1 open/.test(child.description), 'unfolded, it shows the conversation with no dot and its one open row', child);
    await look('stopped-group', { expect: 'The Conversations view: Running a turn with a green dot, then a row Not running, with open rows (1) with a history icon, unfolded, and under it Paused for the night with no dot and idle · 1 open beside it.' }, pane('agentPlus.conversations'));
  });

  await step('problem-row', async () => {
    await src('return src.setProblem(arg);', 'the made-up agent could not read its sessions folder');
    const row = await until(async () => { const r = await convRows(); return r && r[0] && r[0].title === 'Could not list the running conversations' && r[0]; }, 15000, 300);
    check(!!row && row.icon === 'codicon-warning' && row.aria.includes('could not read its sessions folder'),
      'a source that says what went wrong with its list gets a warning row at the top, with what it said in the tooltip', row || await convRows());
    await look('problem-row', { expect: 'The Conversations view\'s first row is Could not list the running conversations, with an orange warning icon; the conversations follow it.' }, pane('agentPlus.conversations'));
    await src('return src.setProblem("");');
    check(!!await until(async () => { const r = await convRows(); return r && !r.some((x) => x.title === 'Could not list the running conversations'); }, 15000, 300),
      'and the row goes once the list comes back without one');
  });

  /* When the question plans were written; a step's "asked 1m ago" is counted from it. */
  let qAt = Date.now();
  const QPLANS = () => {
    qAt = Date.now();
    writePlan('asks-new', { nodes: [
      { title: 'Pick the release branch', state: 'waiting', waitingOn: 'user', question: Q1, asked: iso(qAt - 60e3), since: iso(qAt - 60e3),
        opened: iso(qAt - 2 * HOUR), detail: 'The hotfix branch has two fixes main does not have yet.' },
      { title: 'Rewrite the parser', state: 'doing', since: iso(qAt - 600e3), opened: iso(qAt - 2 * HOUR), detail: 'The old parser reads only the first format.' },
      { title: 'Update the changelog', state: 'todo', opened: iso(qAt - HOUR) }] });
    writePlan('asks-old', { nodes: [{ title: 'Choose the log format', state: 'waiting', waitingOn: 'user', question: Q2, asked: iso(qAt - 3 * 86400e3),
      since: iso(qAt - 3 * 86400e3), opened: iso(qAt - 3 * 86400e3) }] });
  };
  const QCONVS = () => [
    conv('asks-new', 'Asked about the release branch', 'idle', 'stopped', false, { lastUserAt: qAt - HOUR }),
    conv('asks-old', 'Asked days ago', 'working', 'working', false, { lastUserAt: qAt - 60e3 }),
  ];

  await step('question-rows', async () => {
    QPLANS();
    await conversations(QCONVS());
    await showConversations();
    const got = await until(async () => {
      const r = await convRows() || [];
      const a = r.find((x) => x.title === 'Asked about the release branch'), b = r.find((x) => x.title === 'Asked days ago');
      return a && b && r.some((x) => x.title === `1. ${Q1}`) && { a, b, q: r.find((x) => x.title === `1. ${Q1}`) };
    }, 15000, 300);
    check(!!got, 'a conversation with a plan question waiting on the user is listed with the question under it', await convRows());
    if (!got) return;
    const red = await themeColor('charts.red'), green = await themeColor('charts.green');
    check(got.a.icon === 'codicon-circle-filled' && got.a.color === red && got.a.expanded === 'true' && /needs you · 1 question/.test(got.a.description),
      'a question asked after the user\'s last message makes the conversation red, unfolded, and says it needs you', got.a);
    check(got.b.icon === 'codicon-circle-filled' && got.b.color === green && /needs you · 1 question/.test(got.b.description),
      'a question asked before it does not turn a running conversation red', got.b);
    check(got.q.icon === 'codicon-question' && /^asked 1m ago$/.test(got.q.description), 'the question row has a question mark and how long ago it was asked', got.q);
    const tab = await page.evaluate(() => {
      const a = [...document.querySelectorAll('.part.panel .composite-bar .action-item')].find((x) => /Conversations/.test(x.innerText || x.getAttribute('aria-label') || ''));
      const b = a && a.querySelector('.badge-content');
      return b ? b.innerText.trim() : '';
    });
    check(tab === '2', 'the Conversations tab\'s badge counts the two questions', tab);
    const st = await entry('conversations');
    check(!!st && /1 conversation needs you/.test(st.text) && !st.warning && !st.error,
      'and the status bar entry, in the status bar\'s own colours, says 1 conversation needs you: only the conversation whose question came after the user\'s last message counts', st);
    await look('question-rows', { expect: 'Asked about the release branch has a red dot, needs you · 1 question beside it, and under it the question Release from main or from the hotfix branch? (orange question mark, asked 1m ago) and the doing row 2. Rewrite the parser. Asked days ago has a green dot, not red, with its own question under it. The Conversations tab shows a badge of 2, and the status bar has 1 conversation needs you in the bar\'s own colours, with no yellow or red behind it.' },
      pane('agentPlus.conversations'));
  });

  /* Waits for the Answer view's page to show the conversation titled `want.title`, with a question, or with its brief
     when `want.brief` is set. */
  const answerFrame = (want) => until(async () => {
    for (const f of page.frames()) {
      try {
        if (await f.evaluate((x) => {
          const m = document.getElementById(x.brief ? 'brief' : 'main'), t = document.getElementById(x.brief ? 'btitle' : 'conversation');
          return !!m && m.style.display === 'flex' && !!t && t.textContent === x.title;
        }, want)) return f;
      } catch (_) { /* not that frame */ }
    }
    return null;
  }, 20000, 300);
  const answerSays = (f) => f.evaluate(() => ({ row: document.getElementById('row').textContent, question: document.getElementById('question').textContent,
    status: document.getElementById('status').textContent, text: document.getElementById('text').value, send: !document.getElementById('send').disabled,
    box: !document.getElementById('text').disabled, placeholder: document.getElementById('text').placeholder }));
  const answers = () => src('return src.state.answers;');
  let answer = null;

  await step('answer-sent', async () => {
    needs('question-rows');
    await showConversations();
    await viaUi('agentPlus.answerQuestion', () => clickRow('agentPlus.conversations', `1. ${Q1}`));
    answer = await answerFrame({ title: 'Asked about the release branch' });
    check(!!answer, 'a click on the question shows it in the Answer view, under its conversation\'s title');
    if (!answer) return;
    const shown = await answerSays(answer);
    check(shown.question === Q1 && /^Row 1: Pick the release branch · asked 1m ago$/.test(shown.row) && shown.box && !shown.send
      && /Ctrl\+Enter sends it/.test(shown.placeholder),
      'with its row, how long ago it was asked, and an empty box to answer in that says Ctrl+Enter sends, Send disabled until something is typed', shown);
    await look('answer-question', { expect: 'The Answer view, right of Conversations: Asked about the release branch in bold, Row 1: Pick the release branch · asked 1m ago, the question Release from main or from the hotfix branch?, a folded Row details, an empty box with its placeholder, and the buttons Go to the conversation and Send, Send greyed out.' },
      pane('agentPlus.answer'));
    const before = (await answers()).length;
    await clearToasts();
    await answer.locator('#text').fill('From main.');
    await answer.locator('#send').click();
    const got = await until(async () => { const a = await answers(); return a.length > before && a[a.length - 1]; }, 20000, 300);
    check(!!got && got.sessionId === 'asks-new' && got.text === `My answer to row 1 ("${Q1}"):\nFrom main.` && !!got.deliveryId,
      'Send hands the conversation the answer with its row and question, through the window that shows it', got);
    const sent = await until(async () => { const s = await answerSays(answer); return /^Sent at \d\d:\d\d\.$/.test(s.status) && s; }, 15000, 300);
    check(!!sent && sent.text === '', 'and the view says when it was sent and empties the box', sent || await answerSays(answer));
    await look('answer-sent', { expect: 'The Answer view with the same question, an empty box, and Sent at HH:MM. in grey beside the buttons. No error text.' }, pane('agentPlus.answer'));
  });

  await step('answer-drafted', async () => {
    needs('answer-sent');
    await src('return src.configure({ outcome: { outcome: "drafted" } });');
    const before = (await answers()).length;
    await answer.locator('#text').fill('From the hotfix branch.');
    await answer.locator('#text').press('Control+Enter');
    check(!!await until(async () => (await answers()).length > before, 20000, 300), 'Ctrl+Enter sends it too');
    const said = await until(async () => { const s = await answerSays(answer); return /^Put in the conversation's input box at \d\d:\d\d, not sent\./.test(s.status) && s; }, 15000, 300);
    check(!!said && said.text === 'From the hotfix branch.', 'for an answer left in the conversation\'s input box, the view says it is there and was not sent, and keeps the draft', said || await answerSays(answer));
    await look('answer-drafted', { expect: 'The Answer view keeps From the hotfix branch. in the box, and says it was put in the conversation\'s input box at a time, not sent, and to press Enter there.' }, pane('agentPlus.answer'));
  });

  await step('answer-not-received', async () => {
    needs('answer-sent');
    await src('return src.configure({ canDeliver: false, outcome: { outcome: "submitted" } });');
    await clearToasts();
    await answer.locator('#send').click();
    const said = await until(async () => { const s = await answerSays(answer); return /^Not sent: no VS Code window with this conversation open took it\. Copied to the clipboard\.$/.test(s.status) && s; }, 40000, 500);
    check(!!said, 'when no window takes an answer in 15 seconds, the view says it was not sent and copies it to the clipboard', said || await answerSays(answer));
    const clip = await call('return vscode.env.clipboard.readText();');
    check(clip === `My answer to row 1 ("${Q1}"):\nFrom the hotfix branch.`, 'the clipboard holds the answer as it would have been sent', clip);
    await look('answer-not-received', { expect: 'The Answer view keeps the draft and says, in red, Not sent: no VS Code window with this conversation open took it. Copied to the clipboard.' }, pane('agentPlus.answer'));
    await src('return src.configure({ canDeliver: true });');
    await openNotes();
    await clearToasts();
    await answer.locator('#open').click();
    check(!!await frontIs('Asked about the release branch'), 'Go to the conversation in the Answer view brings the conversation\'s tab to the front', await frontTab());
    await openNotes();
  });

  /* ── briefs ── */
  const writeBriefed = (at) => writePlan('briefed', { nodes: [{ title: 'Port the importer', state: 'doing', since: iso(at - 300e3) }, { title: 'Write the tests', state: 'todo' }],
    brief: { summary: 'Porting the importer to the new storage API and keeping the old one readable.', summaryAt: iso(at - 120e3),
      status: { doing: 'Porting the batch writer', progress: 'The reader is ported', next: 'Port the writer, then run the tests' }, statusAt: iso(at - 120e3) } });
  await step('brief-page', async () => {
    const at = Date.now();
    writeBriefed(at);
    await conversations([...QCONVS(), conv('briefed', 'Keeps a brief', 'working', 'working', false, { lastActiveAt: at }),
      conv('built', 'Keeps no brief', 'working', 'working', false, { lastActiveAt: at - 180e3 })]);
    writePlan('built', { nodes: [{ title: 'Read the old importer', state: 'done' }, { title: 'Sketch the new one', state: 'doing', since: iso(at - 60e3), note: 'half done' }] });
    await showConversations();
    await until(async () => !!await convRow('Keeps a brief'), 15000, 300);
    await viaUi('agentPlus.showBrief', () => clickRow('agentPlus.conversations', 'Keeps a brief'));
    const f = await answerFrame({ brief: true, title: 'Keeps a brief' });
    check(!!f, 'a click on a conversation whose agent keeps a brief shows the brief in the Answer view');
    if (!f) return;
    const text = await f.evaluate(() => ({ sections: document.getElementById('bsections').innerText, live: document.getElementById('blive').innerText }));
    check(/Summary\s*written 2m ago/.test(text.sections) && text.sections.includes('Porting the importer to the new storage API')
      && /Where it stands\s*written 2m ago/.test(text.sections) && /Doing\s*Porting the batch writer/.test(text.sections) && /Latest\s*The reader is ported/.test(text.sections)
      && /Next\s*Port the writer/.test(text.sections) && !/May be out of date/.test(text.sections),
    'with its summary and where it stands, and when each was written', text);
    check(/^Now: working · 1\. Port the importer \(doing for 5m\)$/.test(text.live), 'and a line for what runs now', text.live);
    await look('brief-page', { expect: 'The Answer view shows the brief of Keeps a brief: its title with a Go to the conversation button, a blue line Now: working · 1. Port the importer (doing for 5m), a Summary section written 2m ago with one sentence about porting the importer, and Where it stands written 2m ago with Doing, Latest and Next lines. Nothing says it may be out of date.' },
      pane('agentPlus.answer'));
    const plan = JSON.parse(fs.readFileSync(path.join(profile.plans, 'briefed.json'), 'utf8'));
    plan.brief.statusAt = iso(at - 900e3);
    writePlan('briefed', plan);
    await exec('agentPlus.refreshWorkPlan');
    const stale = await until(() => f.evaluate(() => document.getElementById('bsections').innerText).then((s) => /May be out of date: the conversation has run since this was written\./.test(s) && s), 15000, 500);
    check(!!stale, 'a status written more than five minutes before the conversation was last active is marked as possibly out of date', stale);
  });

  await step('brief-built', async () => {
    needs('brief-page');
    await viaUi('agentPlus.showBrief', () => clickRow('agentPlus.conversations', 'Keeps no brief'));
    const f = await answerFrame({ brief: true, title: 'Keeps no brief' });
    const text = f && await f.evaluate(() => document.getElementById('bsections').innerText);
    check(!!text && (text.match(/Put together from the work plan, not written by the conversation\./g) || []).length === 2 && /2\.\s*Sketch the new one \(doing\)/.test(text)
      && /Doing\s*2\. Sketch the new one · half done/.test(text) && /Last active\s*3m ago/.test(text),
    'for a plan with no brief, the page is put together from the plan\'s rows and marked so in both sections', text);
    await look('brief-built', { expect: 'The Answer view shows Keeps no brief. Its Summary lists the plan\'s rows (2. Sketch the new one (doing) first, then 1. Read the old importer (done)), and Where it stands has Doing 2. Sketch the new one · half done and Last active 3m ago; each section says in italics that it was put together from the work plan, not written by the conversation.' },
      pane('agentPlus.answer'));
  });

  await step('go-to-conversation', async () => {
    needs('brief-page');
    await openNotes();
    const row = rowLoc('agentPlus.conversations', 'Keeps a brief');
    await showConversations();
    await clearToasts();
    await row.hover();
    await viaUi('agentPlus.goToConversation', () => row.locator('.action-label[aria-label="Agent Plus: Go to the Conversation"]').click({ timeout: 10000 }));
    check(!!await frontIs('Keeps a brief'), 'the arrow at the end of a conversation\'s row brings its tab to the front', await frontTab());
    await openNotes();
    await viaUi('agentPlus.showBrief', () => clickRow('agentPlus.conversations', 'Keeps a brief'));
    const f = await answerFrame({ brief: true, title: 'Keeps a brief' });
    await clearToasts();
    if (f) await f.locator('#bopen').click({ timeout: 10000 });
    check(!!f && !!await frontIs('Keeps a brief'), 'and so does the button at the top of its brief', await frontTab());
    await openNotes();
  });

  await step('doing-row', async () => {
    needs('question-rows');
    await showConversations();
    await viaUi('agentPlus.openConversation', () => clickRow('agentPlus.conversations', '2. Rewrite the parser'));
    check(!!await frontIs('Asked about the release branch'), 'a click on a doing row brings its conversation\'s tab to the front', await frontTab());
    await look('doing-row', { expect: 'The tab of Asked about the release branch is in front, showing its stand-in page; the Conversations view below has the row 2. Rewrite the parser selected.' });
    await openNotes();
    await exec('agentPlus.openConversation', { sourceId: 'codex', sessionId: 'briefed', title: 'Keeps a brief', cwd: profile.folder });
    check(!!await frontIs('Keeps a brief'), 'and Go to a Conversation does the same for any conversation it is handed', await frontTab());
    await clearToasts();
    await exec('agentPlus.openConversation', { sourceId: 'codex', sessionId: 'nowhere', title: 'Not open anywhere', cwd: profile.folder });
    check(!!await toastWith('"Not open anywhere" is not open in any VS Code window on this machine.', 15000), 'for a conversation no window shows, it says it is not open anywhere', await toasts());
    await clearToasts();
    await openNotes();
  });

  await step('status-entry', async () => {
    needs('question-rows');
    const st = await entry('conversations');
    check(!!st && /1 conversation needs you/.test(st.text), 'the status bar entry says 1 conversation needs you', st);
    const tip = await hoverText(entryLoc('conversations'));
    check(tip.startsWith('1 conversation needs you:') && tip.includes('Asked about the release branch · 1 question') && !tip.includes('Asked days ago'),
      'hovering it lists that conversation with how many questions it has, and not Asked days ago', tip);
    await look('status-hover', { pointer: true, toasts: true, expect: 'A hover box above the status bar entry 1 conversation needs you, reading 1 conversation needs you:, then Asked about the release branch · 1 question on a line of its own; Asked days ago is not in it.' },
      page.locator('.monaco-hover, .workbench-hover').first());
    await unhover();
    await exec('workbench.action.closePanel');
    await clearToasts();
    await viaUi('agentPlus.showConversations', () => entryLoc('conversations').click());
    check(!!await until(async () => !!await convRows(), 10000, 300), 'a click on it shows the Conversations view');
    await exec('workbench.action.closePanel');
    await showPlanView();
    await viaUi('agentPlus.showConversations', () => page.locator('#workbench\\.parts\\.sidebar .title-actions .action-label[aria-label="Agent Plus: Show Conversations"]').click({ timeout: 10000 }));
    check(!!await until(async () => !!await convRows(), 10000, 300), 'and so does the Conversations button in the Work plan view\'s title bar');
    await conversations([conv('run', 'Running a turn', 'working', 'working'), conv('bg', 'Only background work left', 'working', 'background')]);
    const idle = await until(async () => { const e = await entry('conversations'); return e && /Conversations 2/.test(e.text) && !e.error && !e.warning && e; }, 15000, 300);
    check(!!idle, 'with no question waiting it counts the running conversations instead, on no background', idle || await entry('conversations'));
    await look('status-entry', { expect: 'The status bar at the bottom right has a speech-bubble entry Conversations 2 on the plain status bar colour, beside the token mode entry All; the Conversations view is open in the panel.' },
      page.locator('#workbench\\.parts\\.statusbar'));
  });

  /* ── the Work plan view ── */
  await step('plan-follows-tab', async () => {
    needs('question-rows');
    QPLANS();
    writeBriefed(Date.now());
    await conversations([...QCONVS(), conv('briefed', 'Keeps a brief', 'working', 'working')]);
    await openConv('asks-new');
    await showPlanView();
    await sideBarWidth(640);
    const a = await until(async () => { const r = await treeRows('agentPlus.workPlan'); return r && sameList(r.map((x) => x.title), ['3. Update the changelog', '2. Rewrite the parser', '1. Pick the release branch']) && r; }, 15000, 300);
    check(!!a, 'with a conversation\'s tab in front, the Work plan view shows its plan, the newest row first, each numbered by its place in the file', await planRows());
    const head = await page.evaluate(() => { const h = document.querySelector('#workbench\\.view\\.extension\\.agentPlus .pane-header'); return h ? h.getAttribute('aria-label') : ''; });
    check(/^Work plan - Codex/.test(head || ''), 'and names the agent', head);
    const badge = await page.evaluate((re) => {
      const a = [...document.querySelectorAll('.activitybar .action-item')].find((x) => { const l = x.querySelector('.action-label'); return !!l && new RegExp(re).test(l.getAttribute('aria-label') || ''); });
      const b = a && a.querySelector('.badge-content');
      return b ? b.innerText.trim() : '';
    }, PLAN_ENTRY);
    check(badge === '1', 'its badge in the activity bar counts the one row still to do', badge);
    if (a) {
      const blue = await themeColor('charts.blue'), orange = await themeColor('charts.orange'), purple = await themeColor('charts.purple');
      const opened = /^\d\d\/\d\d \d\d:\d\d/;
      check(a[1].icon === 'codicon-debug-start' && a[1].color === blue && opened.test(a[1].description) && / · for 10m$/.test(a[1].description)
        && a[2].icon === 'codicon-question' && a[2].color === orange && / · for 1m$/.test(a[2].description)
        && a[0].icon === 'codicon-circle-large-outline' && a[0].color === purple && opened.test(a[0].description) && !/for/.test(a[0].description),
      'each row\'s icon shows its state, or a question mark on a row waiting for the user\'s answer, with when it was opened beside it, and a doing or waiting row says how long it has been in that state', a);
    }
    await look('plan-follows-tab', { expect: 'The Agent Plus side bar shows the Work plan of Asked about the release branch, top to bottom: 3. Update the changelog with a purple ring, 2. Rewrite the parser with a blue triangle and for 10m, 1. Pick the release branch with an orange question mark and for 1m. The Agent Plus icon in the activity bar carries a badge of 1.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    await viaUi('agentPlus.answerQuestionOf', () => clickRow('agentPlus.workPlan', '1. Pick the release branch'));
    const asked = await answerFrame({ title: 'Asked about the release branch' });
    check(!!asked && (await answerSays(asked)).question === Q1, 'a click on that row opens its question in the Answer view', asked && await answerSays(asked));
    await showConversations();
    const firstRow = await until(async () => {
      const top = (await convRows() || []).filter((r) => r.level === 1 && !/^Not running, with open rows|^Could not list/.test(r.title));
      return top[0] && top[0].title === 'Asked about the release branch' && top.map((r) => r.title);
    }, 10000, 300);
    check(!!firstRow, 'the conversation in front heads the Conversations view', await convRows());
    await openConv('briefed');
    const b = await until(async () => { const r = await planRows(); return r && sameList(r.map((x) => x.title), ['2. Write the tests', '1. Port the importer']) && r; }, 15000, 300);
    check(!!b, 'bringing another conversation\'s tab to the front shows that one\'s plan', await planRows());
    await openNotes();
    await sleep(1000);
    const kept = await planRows();
    check(!!kept && sameList(kept.map((x) => x.title), ['2. Write the tests', '1. Port the importer']), 'and a tab that is no conversation leaves the view where it was', kept);
  });

  await step('plan-hover', async () => {
    needs('plan-follows-tab');
    await openConv('asks-new');
    await showPlanView();
    await until(async () => { const r = await planRows(); return r && r.some((x) => x.title === '1. Pick the release branch'); }, 15000, 300);
    const tip = await hoverText(rowLoc('agentPlus.workPlan', '1. Pick the release branch'));
    check(/Pick the release branch/.test(tip) && /waiting on you for \d+m/.test(tip) && tip.includes(`Question: ${Q1}`) && /The hotfix branch has two fixes/.test(tip),
      'hovering a row shows its title, who it waits on and for how long, its question and its description', tip);
    await look('plan-hover', { pointer: true, toasts: true, expect: 'A hover box beside the row 1. Pick the release branch in the Work plan view, with the title in bold, waiting on you for some minutes, Question: Release from main or from the hotfix branch?, the date and time the row was opened, and the sentence about the hotfix branch.' },
      page.locator('.monaco-hover, .workbench-hover').first());
    await unhover();
  });

  await step('plan-row-detail', async () => {
    needs('plan-follows-tab');
    await showPlanView();
    await viaUi('agentPlus.showWorkPlanDetail', () => clickRow('agentPlus.workPlan', '2. Rewrite the parser'));
    const d = await until(dialog, 10000, 300);
    check(!!d && /Rewrite the parser/.test(d.text) && /doing for \d+m/.test(d.text) && /The old parser reads only the first format/.test(d.text),
      'clicking a row with no question opens a dialog with its title, state and description', d);
    await look('plan-row-detail', { toasts: true, expect: 'A dialog in the middle of the window titled Rewrite the parser, with doing for some minutes, the date and time the row was opened, then after a blank line the sentence about the old parser, and an OK button.' },
      page.locator('.monaco-dialog-box').first());
    await page.keyboard.press('Escape');
    check(!!await until(async () => !await dialog(), 5000, 200), 'and Escape closes it');
  });

  await step('write-about-row', async () => {
    needs('plan-follows-tab');
    await openConv('asks-new');
    await showPlanView();
    await src('src.state.prefilled.length = 0; src.configure({ prefillOutcome: { outcome: "drafted" } }); return true;');
    const row = rowLoc('agentPlus.workPlan', '2. Rewrite the parser');
    const pen = row.locator('.action-label[aria-label="Agent Plus: Write About This Row in Its Conversation"]');
    await row.hover();
    await look('write-about-row', { pointer: true, expect: 'The row 2. Rewrite the parser in the Work plan view, under the pointer, with a pen button at its right end.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    await viaUi('agentPlus.writeAboutRow', () => pen.click({ timeout: 10000 }));
    const got = await until(async () => { const p = await src('return src.state.prefilled;'); return p && p.length && p; }, 10000, 300);
    check(!!got && got[0].sessionId === 'asks-new' && got[0].text === 'About row 2 (Rewrite the parser): ',
      'the pen on a row asks the conversation\'s agent to put "About row 2 (Rewrite the parser): " in its message box', got);
    await src('src.configure({ prefillOutcome: { outcome: "notReceived", reason: "no message box here" } }); return true;');
    await clearToasts();
    await row.hover();
    await pen.click({ timeout: 10000 });
    const t = await toastWith('could not put it in the conversation', 10000);
    const clip = await call('return vscode.env.clipboard.readText();');
    check(!!t && /no message box here/.test(t.text) && clip === 'About row 2 (Rewrite the parser): ',
      'when the agent could not put it there, the text is on the clipboard and a notification says why', { toast: t, clip });
    await src('src.configure({ prefillOutcome: { outcome: "drafted" } }); return true;');
    await clearToasts();
  });

  await step('plan-file', async () => {
    needs('plan-follows-tab');
    await openConv('asks-new');
    await showPlanView();
    await viaUi('agentPlus.openWorkPlanFile', () => page.locator('#workbench\\.parts\\.sidebar .title-actions .action-label[aria-label="Agent Plus: Open the Work Plan File"]').click({ timeout: 10000 }));
    const t = await until(async () => { const x = await frontTab(); return x && x.label === 'asks-new.json' && x; }, 15000, 300);
    check(!!t && path.basename(t.file) === 'asks-new.json', 'Open the Work Plan File in the title bar opens the plan of the conversation in front in an editor', await frontTab());
    await look('plan-file', { expect: 'An editor tab asks-new.json in front, showing the plan as indented JSON beginning with its rows; the Work plan view still shows that plan.' });
    await openConv('briefed');
    await showPlanView();
    await until(async () => { const r = await planRows(); return r && r.some((x) => x.title === '1. Port the importer'); }, 15000, 300);
    await clickRow('agentPlus.workPlan', '1. Port the importer', { button: 'right' });
    const item = page.locator('.monaco-menu .action-item').filter({ hasText: 'Open the Work Plan File' }).first();
    if (await item.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
      await look('plan-file-menu', { pointer: true, toasts: true, expect: 'A right-click menu beside the row 1. Port the importer in the Work plan view, with the entry Agent Plus: Open the Work Plan File.' },
        page.locator('.monaco-menu-container, .context-view').first());
      await viaUi('agentPlus.openWorkPlanFile', () => item.click());
      check(!!await until(async () => { const x = await frontTab(); return x && x.label === 'briefed.json'; }, 15000, 300), 'and the same entry on a row\'s right-click menu opens the file too', await frontTab());
    } else {
      note(`no right-click menu was drawn in the window on ${process.platform}, so the row's menu entry was not clicked`);
      await page.keyboard.press('Escape');
    }
    await openNotes();
  });

  await step('plan-refresh', async () => {
    needs('plan-follows-tab');
    const file = path.join(profile.plans, 'asks-new.json');
    /* Whole seconds, since some file systems keep modification times only to the second. */
    const stamp = Math.floor(Date.now() / 1000) - 5;
    fs.utimesSync(file, stamp, stamp);
    await openConv('asks-new');
    await showPlanView();
    await exec('agentPlus.refreshWorkPlan');
    await until(async () => { const r = await planRows(); return r && r.some((x) => x.title === '2. Rewrite the parser'); }, 15000, 300);
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('Rewrite the parser', 'Rewrite the lexers'));
    fs.utimesSync(file, stamp, stamp);
    await sleep(2500);
    const kept = await planRows();
    check(!!kept && kept.some((x) => x.title === '2. Rewrite the parser'), 'a plan rewritten with the same size and modification time is not read again by itself', kept);
    await viaUi('agentPlus.refreshWorkPlan', () => page.locator('#workbench\\.parts\\.sidebar .title-actions .action-label[aria-label="Agent Plus: Refresh"]').click({ timeout: 10000 }));
    check(!!await until(async () => { const r = await planRows(); return r && r.some((x) => x.title === '2. Rewrite the lexers'); }, 10000, 300),
      'Refresh in the title bar reads it afresh', await planRows());
    QPLANS();
  });

  await step('plan-summary', async () => {
    needs('plan-follows-tab');
    QPLANS();
    const API = 'const api = vscode.extensions.getExtension("xnervwang.agent-plus").exports.agentPlus;';
    const sum = await until(() => call(`${API} return api.features.includes("planSummary") && api.planSummary("codex", "asks-new");`), 10000, 300);
    check(!!sum && sum.total === 3 && sum.done === 0 && !!sum.current && sum.current.number === '2' && sum.current.state === 'doing' && sum.questions === 1
      && sameList(sum.open.map((r) => r.number), ['1', '2', '3']),
    'planSummary gives a conversation\'s plan in a plan bar\'s figures: none of 3 rows done, row 2 doing as the current one, one question', sum);
    await call(`${API} globalThis.__planTold = []; globalThis.__planSub = api.onDidChangePlanSummary((e) => globalThis.__planTold.push([e.sourceId, e.sessionId])); return true;`);
    const plan = JSON.parse(fs.readFileSync(path.join(profile.plans, 'asks-new.json'), 'utf8'));
    plan.nodes[1].state = 'done';
    writePlan('asks-new', plan);
    const told = await until(() => call('return globalThis.__planTold.length ? globalThis.__planTold : null;'), 15000, 300);
    check(!!told && sameList(told[0], ['codex', 'asks-new']), 'a change to the plan file fires onDidChangePlanSummary with the agent and the conversation', told);
    const after = await call(`${API} return api.planSummary({ sourceId: "codex", sessionId: "asks-new" });`);
    check(!!after && after.done === 1 && after.current === null,
      'and the summary asked for then has row 2 done and, with no row doing any more, no current row', after);
    await call('globalThis.__planSub.dispose(); return true;');
    QPLANS();
    await openConv('briefed');
    await showPlanView();
    await until(async () => { const r = await planRows(); return r && r.some((x) => x.title === '1. Port the importer'); }, 15000, 300);
    await exec('agentPlus.showWorkPlanOf', { sourceId: 'codex', sessionId: 'asks-new' });
    const rows = await until(async () => { const r = await planRows(); return r && sameList(r.map((x) => x.title), ['3. Update the changelog', '2. Rewrite the parser', '1. Pick the release branch']) && r; }, 15000, 300);
    check(!!rows, 'agentPlus.showWorkPlanOf moves the Work plan view to the conversation it is handed, though another conversation\'s tab is in front', await planRows());
    await look('plan-summary-plan', { expect: 'The Agent Plus side bar shows the Work plan of Asked about the release branch (3. Update the changelog, 2. Rewrite the parser, 1. Pick the release branch), while the tab in front is Keeps a brief.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    await exec('agentPlus.answerQuestionOf', { sourceId: 'codex', sessionId: 'asks-new' });
    const f = await answerFrame({ title: 'Asked about the release branch' });
    const shown = f && await answerSays(f);
    check(!!shown && shown.question === Q1 && /^Row 1: Pick the release branch/.test(shown.row), 'agentPlus.answerQuestionOf shows that conversation\'s question in the Answer view', shown);
    await look('plan-summary-answer', { expect: 'The Answer view shows Asked about the release branch with Row 1: Pick the release branch, the question Release from main or from the hotfix branch?, and a box to answer in.' },
      pane('agentPlus.answer'));
    await openNotes();
  });

  await step('plan-notice', async () => {
    needs('plan-follows-tab');
    await openConv('asks-new');
    await showPlanView();
    await src('return src.setNotice(arg);', { title: 'The work plan plugin is not installed', description: 'click to install it',
      detail: 'The made-up agent could not install its plugin.', command: 'agentPlusTest.installPlugin', arguments: [] });
    const row = await until(async () => { const r = await planRows(); return r && r[0] && r[0].title === 'The work plan plugin is not installed' && r[0]; }, 15000, 300);
    check(!!row && row.icon === 'codicon-warning' && row.description === 'click to install it', 'the agent\'s notice is the first row of the plan, with a warning icon', row || await planRows());
    await look('plan-notice', { expect: 'The Work plan view\'s first row is The work plan plugin is not installed, with an orange warning icon and click to install it beside it; the plan\'s rows follow.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    await clickRow('agentPlus.workPlan', 'The work plan plugin is not installed');
    check(!!await until(async () => (await src('return src.state.ran;')).includes('installPlugin'), 10000, 300), 'a click on it runs the agent\'s command');
    await src('return src.setNotice(null);');
    check(!!await until(async () => { const r = await planRows(); return r && r[0] && r[0].title !== 'The work plan plugin is not installed'; }, 10000, 300), 'and it goes once the agent takes it back');
  });

  await step('plan-unknown', async () => {
    needs('plan-follows-tab');
    await openConv('asks-new');
    await showPlanView();
    const plan = JSON.parse(fs.readFileSync(path.join(profile.plans, 'asks-new.json'), 'utf8'));
    plan.nodes.push({ title: 'Review the change', state: 'reviewing' });
    writePlan('asks-new', plan);
    const row = await until(async () => (await planRows() || []).find((x) => x.title === '4. Review the change'), 15000, 300);
    check(!!row && row.icon === 'codicon-question' && row.description === '"reviewing": this version of Agent Plus does not know this state',
      'a row in a state this version does not know is drawn with a question mark and says so', row || await planRows());
    await showConversations();
    const c = await until(async () => { const r = await convRow('Asked about the release branch'); return r && /1 in a state this version does not know/.test(r.description) && r; }, 15000, 300);
    check(!!c, 'and the conversation\'s row in Conversations says how many such rows it has', await convRow('Asked about the release branch'));
    await showPlanView();
    await look('plan-unknown', { expect: 'The Work plan view has 4. Review the change with a grey question mark and "reviewing": this version of Agent Plus does not know this state beside it, after the other rows.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    writePlan('asks-new', Object.assign({}, plan, { format: 2 }));
    check(!!await until(async () => { const r = await planRows(); return r && r[0] && r[0].title === 'This plan is in a newer format' && /^format 2; this version reads 1$/.test(r[0].description); }, 15000, 300),
      'a plan in a newer format gets a row above its rows naming its format and the one this version reads', await planRows());
    fs.writeFileSync(path.join(profile.plans, 'asks-new.json'), '{ "nodes": [ { "title": ');
    check(!!await until(async () => { const r = await planRows(); return r && r.length === 1 && r[0].title === 'This work plan could not be read'; }, 20000, 500),
      'and a plan that still does not parse after the time a write may take is shown as unreadable', await planRows());
    QPLANS();
  });

  await step('plan-no-conversation', async () => {
    needs('plan-follows-tab');
    await src('return src.openNew();');
    await showPlanView();
    const shown = await until(async () => { const r = await planRows(); const m = await welcome('agentPlus.workPlan'); return (!r || !r.length) && m && m; }, 15000, 300);
    check(shown === 'No work plan for the conversation in front.', 'a tab of the agent with no conversation yet shows the view\'s welcome text and no rows', { rows: await planRows(), welcome: await welcome('agentPlus.workPlan') });
    await look('plan-no-conversation', { expect: 'A tab New conversation in front; the Work plan view has no rows and says No work plan for the conversation in front.' },
      page.locator('#workbench\\.parts\\.sidebar'));
    await src('return src.close("");');
    await openNotes();
  });

  await step('several-agents', async () => {
    await conversations(DOTS.slice(0, 5).map(([id, title, state, activity, unseen]) => conv(id, title, state, activity, unseen)));
    await src('return src.addOther(arg);', [conv('cc-1', 'A Claude Code conversation', 'working', 'working'), conv('cc-2', 'Claude Code, stopped', 'idle', 'stopped')]);
    await showConversations();
    const drawn = await until(async () => {
      const r = await convRows() || [];
      const ours = r.filter((x) => DOTS.slice(0, 5).some(([, t]) => t === x.title) || /Claude Code/.test(x.title));
      return ours.length === 7 && ours.every((x) => /conversation-icons/.test(x.image)) && ours;
    }, 20000, 500);
    check(!!drawn, 'with two agents registered, every conversation\'s row is drawn with its agent\'s logo', drawn || await convRows());
    const cc = await convRow('A Claude Code conversation');
    check(!!cc && /\nClaude Code\n/.test(cc.aria), 'and its tooltip names the agent', cc);
    await look('several-agents', { expect: 'The Conversations view lists seven conversations, each with a small logo instead of a plain dot: a blue square with a white plus for the five Codex ones, an orange circle with a white star for the two Claude Code ones. The logos of running conversations carry a green dot at the top right (a hollow green ring on Only background work left), At a permission prompt carries a blue one, and Claude Code, stopped has the logo alone.' },
      pane('agentPlus.conversations'));
    await src('return src.removeOther();');
    check(!!await until(async () => { const r = await convRow('Running a turn'); return r && r.icon === 'codicon-circle-filled' && !/conversation-icons/.test(r.image); }, 15000, 300),
      'and once only one agent is left, the rows have their plain dots again', await convRow('Running a turn'));
  });

  /* ── notifications and the count ── */
  let canFocus = false;
  const settle = () => sleep(2500);
  const startWorking = async (list) => { await conversations(list); await settle(); };
  const NWAIT = 'Waits for permission', NFIN = 'Finished a turn', NENV = 'Envelope only', NQUEUE = 'Followed by a queued message', NFRONT = 'In front';
  let base = [];
  await step('notify-waiting', async () => {
    /* The request limit's notice comes up on the first start; the request-limit step answers it. */
    needs('request-limit');
    await openNotes();
    await clearToasts();
    base = [conv('n-wait', NWAIT, 'working', 'working'), conv('n-fin', NFIN, 'working', 'working'), conv('n-env', NENV, 'idle', 'stopped'),
      conv('n-queue', NQUEUE, 'working', 'working'), conv('n-front', NFRONT, 'working', 'working')];
    await startWorking(base);
    canFocus = await focused();
    const before = await bell();
    await patch('n-wait', { state: 'prompt', activity: 'waiting' });
    const counted = await until(async () => (await bell()) === before + 1, 10000, 300);
    check(!!counted, 'a conversation that starts to wait adds one to the count in the status bar', { before, now: await bell() });
    const tip = await entry('conversations');
    check(!!tip && tip.label.includes('Waiting for you to approve something or answer') && tip.label.includes(NWAIT) && !tip.warning,
      'its hover lists it under Waiting for you to approve something or answer, and the entry keeps the status bar\'s own colours', tip);
    if (!canFocus) {
      check(await noToast(NWAIT, 6000), `with no window focused (this ${process.platform} runner gave the window none), no notification is shown`);
      return;
    }
    const t = await toastWith(`"${NWAIT}" is waiting for you.`, 10000);
    check(!!t && sameList(t.buttons, ['Open', 'Dismiss']), 'the focused window shows a notification that it is waiting for you, with Open and Dismiss', t || await toasts());
    await look('notify-waiting', { toasts: true, expect: 'A notification at the bottom right with the buttons Open and Dismiss, reading "Waits for permission" is waiting for you. In the status bar, in its own colours, N conversations need you.' },
      toastLoc(`"${NWAIT}" is waiting for you.`));
    await press(`"${NWAIT}" is waiting for you.`, 'Dismiss');
    check(await until(async () => !(await toasts()).some((x) => x.text.includes(NWAIT)), 5000, 200) && (await bell()) === before + 1,
      'Dismiss closes it, and the conversation is still counted', { bell: await bell(), toasts: await toasts() });
  });

  await step('notify-finished', async () => {
    needs('notify-waiting');
    const before = await bell();
    const at = Date.now();
    await patch('n-fin', { state: 'unread', activity: 'stopped', unseen: true });
    if (canFocus) {
      check(await noToast(NFIN, 3500), 'a conversation that stops with a reply not read is not announced at once');
      const t = await toastWith(`"${NFIN}" finished.`, 12000);
      check(!!t && sameList(t.buttons, ['Open', 'Dismiss']), `but once it has stayed stopped for five seconds, the notification says it finished (after ${Math.round((Date.now() - at) / 1000)} s), with Open and Dismiss`, t || await toasts());
      await look('notify-finished', { toasts: true, expect: 'A notification: "Finished a turn" finished., with Open and Dismiss. The status bar entry counts no more than before.' }, toastLoc(`"${NFIN}" finished.`));
    } else check(await noToast(NFIN, 9000), 'with no window focused, a conversation that stops is not announced');
    await settle();
    check((await bell()) === before, 'and the status bar does not count it, since its notification covers it', { before, now: await bell() });
  });

  await step('notify-open', async () => {
    needs('notify-finished');
    const before = await bell();
    if (canFocus && (await toasts()).some((x) => x.text.includes(`"${NFIN}" finished.`))) {
      await viaUi('agentPlus.openAttention', () => press(`"${NFIN}" finished.`, 'Open'));
    } else {
      if (canFocus) note('the notification had left the screen before Open was clicked, so Open a Conversation That Needs You was run directly');
      await exec('agentPlus.openAttention', 'codex', 'n-fin');
    }
    check(!!await frontIs(NFIN), 'Open brings the conversation\'s tab to the front', await frontTab());
    await settle();
    check((await bell()) === before, 'and the status bar count does not change', { before, now: await bell() });
    await openNotes();
  });

  await step('notify-envelope-only', async () => {
    needs('notify-waiting');
    const before = await bell();
    await patch('n-env', { unseen: true });
    check(await noToast(NENV, 9000), 'a conversation that had already stopped and only gains an envelope is not announced');
    check((await bell()) === before, 'nor counted in the status bar', { before, now: await bell() });
  });

  await step('notify-queued', async () => {
    needs('notify-waiting');
    const before = await bell();
    await patch('n-queue', { state: 'unread', activity: 'stopped', unseen: true });
    await sleep(1500);
    await patch('n-queue', { state: 'working', activity: 'working' });
    check(await noToast(NQUEUE, 9000), 'a conversation that stops and starts working again within five seconds, as it does with a queued message, is not announced');
    check((await bell()) === before, 'and, working again, is not counted', { before, now: await bell() });
  });

  await step('notify-front', async () => {
    needs('notify-waiting');
    await openConv('n-front');
    await frontIs(NFRONT);
    await settle();
    const before = await bell();
    await patch('n-front', { state: 'prompt', activity: 'waiting' });
    check(await noToast(NFRONT, 6000), 'the conversation in front of the focused window starting to wait is not announced');
    check((await bell()) === before, 'nor counted', { before, now: await bell() });
    await patch('n-front', { state: 'working', activity: 'working' });
    await settle();
    await patch('n-front', { state: 'unread', activity: 'stopped', unseen: true });
    check(await noToast(NFRONT, 9000), 'nor is it announced when it then stops with a reply');
    check((await bell()) === before, 'which is not counted either while it is in front', { before, now: await bell() });
    await openNotes();
    await settle();
    check((await bell()) === before, 'and once another tab is in front it is still not counted', { before, now: await bell() });
    check(await noToast(NFRONT, 4000), 'but not announced after the fact');
    await look('attention-count', { expect: 'The status bar at the bottom right has N conversations need you in the bar\'s own colours; there is no separate bell entry of Agent Plus, and no notification is on screen.' },
      page.locator('#workbench\\.parts\\.statusbar'));
  });

  await step('attention-count', async () => {
    needs('notify-waiting');
    const before = await bell();
    await openConv('n-wait');
    check(!!await until(async () => (await bell()) === before - 1, 10000, 300), 'bringing a waiting conversation to the front takes it out of the count', { before, now: await bell() });
    await patch('n-wait', { state: 'working', activity: 'working' });
    await openNotes();
    check(!!await until(async () => (await bell()) === before - 1, 10000, 300), 'and once it is no longer waiting it stays out of it', { before, now: await bell() });
  });

  await step('notify-several', async () => {
    needs('notify-waiting');
    await clearToasts();
    await startWorking([...base.map((c) => Object.assign({}, c, { state: 'idle', activity: 'stopped', unseen: false })),
      conv('n-a', 'First of two', 'working', 'working'), conv('n-b', 'Second of two', 'working', 'working')]);
    await patch('n-a', { state: 'prompt', activity: 'waiting' });
    await patch('n-b', { state: 'prompt', activity: 'waiting' });
    const FIRST = '"First of two" is waiting for you.', SECOND = '"Second of two" is waiting for you.';
    if (!canFocus) { check(await noToast('of two', 6000), 'with no window focused, two conversations starting to wait are not announced'); return; }
    const a = await toastWith(FIRST, 10000), b = await toastWith(SECOND, 5000);
    const both = (await toasts()).filter((x) => /of two/.test(x.text));
    check(!!a && !!b && sameList(a.buttons, ['Open', 'Dismiss']) && sameList(b.buttons, ['Open', 'Dismiss']) && both.length === 2,
      'two conversations that start to wait together get one notification each, with Open and Dismiss, and nothing else is shown about them', both);
    const area = await page.evaluate(() => {
      const rs = [...document.querySelectorAll('.notification-toast')].filter((e) => e.offsetParent !== null && /of two/.test(e.innerText)).map((e) => e.getBoundingClientRect());
      if (!rs.length) return null;
      const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
      return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y };
    });
    await look('notify-several', { toasts: true, expect: 'Two notifications at the bottom right, one above the other: "First of two" is waiting for you. and "Second of two" is waiting for you., each with the buttons Open and Dismiss, and no other notification about either.' },
      area);
    await viaUi('agentPlus.openAttention', () => press(SECOND, 'Open'));
    check(!!await frontIs('Second of two'), 'Open on the notification about the second brings the second to the front', await frontTab());
    if ((await toasts()).some((x) => x.text.includes(FIRST))) {
      await viaUi('agentPlus.openAttention', () => press(FIRST, 'Open'));
      check(!!await frontIs('First of two'), 'and Open on the one about the first, still on screen, brings the first to the front', await frontTab());
    } else note('the notification about the first had left the screen before its Open was clicked');
    await openNotes();
  });

  await step('attention-list', async () => {
    needs('notify-waiting');
    await startWorking([conv('n-a', 'First of two', 'prompt', 'waiting'), conv('n-fin2', 'Stopped while you were away', 'unread', 'stopped', true)]);
    await clearToasts();
    await start('agentPlus.showAttention');
    const rows = await pickRows();
    check(!!rows && rows.some((r) => /First of two.*waiting for you/.test(r.text)) && rows.some((r) => /Stopped while you were away.*finished/.test(r.text)),
      'Show the Conversations That Need You lists the conversations waiting for you and those that finished with a reply not read', rows);
    await look('attention-list', { toasts: true, expect: 'A list at the top of the window headed Conversations that need you, with First of two (waiting for you) and Stopped while you were away (finished), each with the folder under it.' },
      page.locator('.quick-input-widget'));
    await pick('Stopped while you were away');
    check(!!await frontIs('Stopped while you were away'), 'picking one brings it to the front', await frontTab());
    await openNotes();
    await startWorking([conv('quiet', 'Nothing to see', 'idle', 'stopped')]);
    await clearToasts();
    await exec('agentPlus.showAttention');
    check(!!await toastWith('No conversation needs you now.', 10000), 'with nothing counted, Show the Conversations That Need You says so', await toasts());
    check((await bell()) === 0, 'and the status bar counts none', await entry('conversations'));
    await clearToasts();
  });

  await step('notify-settings', async () => {
    needs('notify-waiting');
    await openNotes();
    await startWorking([conv('s-wait', 'Waits with waiting off', 'working', 'working'), conv('s-fin', 'Finishes with finished off', 'working', 'working'),
      conv('s-all', 'Waits with notifications off', 'working', 'working')]);
    await setting('agentPlus.notifications.waiting', false);
    await patch('s-wait', { state: 'prompt', activity: 'waiting' });
    check(await noToast('Waits with waiting off', 6000), 'with agentPlus.notifications.waiting off, a conversation starting to wait is not announced');
    check((await bell()) === 1, 'but the status bar still counts it', await bell());
    await setting('agentPlus.notifications.waiting', true);
    await setting('agentPlus.notifications.finished', false);
    await patch('s-fin', { state: 'unread', activity: 'stopped', unseen: true });
    check(await noToast('Finishes with finished off', 10000), 'with agentPlus.notifications.finished off, a conversation stopping with a reply is not announced');
    check((await bell()) === 1, 'and the status bar does not count it, as it leaves an unread reply to its notification', await bell());
    await setting('agentPlus.notifications.finished', true);
    if (canFocus) {
      await patch('s-wait', { state: 'working', activity: 'working' });
      await settle();
      await patch('s-wait', { state: 'prompt', activity: 'waiting' });
      check(!!await toastWith('"Waits with waiting off" is waiting for you.', 10000), 'turned back on, the next wait is announced again', await toasts());
    }
    await clearToasts();
    await setting('agentPlus.notifications.enabled', false);
    check(!!await until(async () => (await bell()) === 0, 10000, 300), 'with agentPlus.notifications.enabled off, the status bar stops counting them', await entry('conversations'));
    await patch('s-all', { state: 'prompt', activity: 'waiting' });
    check(await noToast('Waits with notifications off', 6000) && (await bell()) === 0, 'and a conversation starting to wait is neither announced nor counted');
    await look('notify-settings', { expect: 'The Conversations entry of Agent Plus in the status bar reads Conversations and a number, not N conversations need you, and no notification is on screen, although two conversations wait.' },
      page.locator('#workbench\\.parts\\.statusbar'));
    await setting('agentPlus.notifications.enabled', true);
    check(!!await until(async () => (await bell()) === 2, 10000, 300), 'turned back on, the status bar counts the two waiting again', await bell());
    await startWorking([conv('quiet', 'Nothing to see', 'idle', 'stopped')]);
    await clearToasts();
  });

  /* ── the token mode ── */
  const tip = async () => { await clearToasts(); return hoverText(entryLoc('tokenMode')); };
  const tipFor = (mode, on, off) => [`Token mode: ${mode}`, `Adds to the agent's context: ${on.length ? on.join(', ') : 'nothing'}`,
    ...(off.length ? [`Left out: ${off.join(', ')}`] : []), 'What the extensions show in VS Code costs no tokens.', 'Click to choose another mode.'].join('\n');
  const tipIs = async (want) => until(async () => { const t = await tip(); await unhover(); return t.replace(/\r/g, '') === want && t; }, 10000, 500);

  await step('token-mode-entry', async () => {
    const e = await until(() => entry('tokenMode'), 10000, 300);
    check(!!e && e.text === 'All', 'the token mode entry in the status bar shows the mode\'s short name', e);
    const want = tipFor('All features', ALL_FEATURES, []);
    const t = await tip();
    check(t.replace(/\r/g, '') === want, 'its hover says what the mode adds to the agent\'s context', { got: t, want });
    await look('token-mode-hover', { pointer: true, toasts: true, expect: 'A hover box over the token mode entry All at the bottom right: Token mode: All features, then Adds to the agent\'s context: work plan, time-zone note, conversation brief, wake-ups, notices when a detached command stops, then What the extensions show in VS Code costs no tokens. and Click to choose another mode.' },
      page.locator('.monaco-hover, .workbench-hover').first());
    await unhover();
  });

  await step('token-mode-switch', async () => {
    await clearToasts();
    await viaUi('agentPlus.chooseTokenMode', () => entryLoc('tokenMode').click());
    const rows = await pickRows();
    check(!!rows && sameList(rows.map((r) => r.label), ['Interface features', 'Essential features', 'All features', 'Custom'])
      && /no tokens/.test(rows[0].text) && /current/.test(rows[2].text), 'a click on it lists the four modes, Interface saying it costs no tokens and All marked current', rows);
    await look('token-mode-list', { toasts: true, expect: 'A list at the top of the window titled Token mode with Interface features (no tokens), Essential features, All features (default, with a tick and current) and Custom, each with a line under it saying what it adds.' },
      page.locator('.quick-input-widget'));
    await pick('Interface features');
    check(!!await until(async () => (await userValue('agentPlus.tokenMode')) === 'interface', 5000, 200), 'picking Interface features sets the mode');
    check(!!await until(async () => { const e = await entry('tokenMode'); return e && e.text === 'Interface'; }, 5000, 200), 'and the entry says Interface', await entry('tokenMode'));
    check(!!await tipIs(tipFor('Interface features', [], ALL_FEATURES)), 'and its hover says it adds nothing and lists every feature under Left out', await tip());
    await unhover();
    await clearToasts();
    await viaUi('agentPlus.chooseTokenMode', () => entryLoc('tokenMode').click());
    await pickRows();
    await pick('Essential features');
    check(!!await until(async () => { const e = await entry('tokenMode'); return e && e.text === 'Essential'; }, 5000, 200), 'choosing Essential features the same way shows Essential', await entry('tokenMode'));
    check(!!await tipIs(tipFor('Essential features', ALL_FEATURES.slice(0, 2), ALL_FEATURES.slice(2))), 'with the work plan and the time-zone note only', await tip());
    await unhover();
    await setting('agentPlus.tokenMode', 'all');
    check(!!await until(async () => { const e = await entry('tokenMode'); return e && e.text === 'All'; }, 5000, 200), 'and the entry follows the setting changed by hand back to All', await entry('tokenMode'));
  });

  await step('token-mode-custom', async () => {
    try {
      await clearToasts();
    await viaUi('agentPlus.chooseTokenMode', () => entryLoc('tokenMode').click());
      await pickRows();
      await pick('Custom');
      check(!!await until(async () => (await userValue('agentPlus.tokenMode')) === 'custom', 5000, 200), 'picking Custom sets the mode');
      const settings = await until(async () => {
        const x = await page.evaluate(() => {
          const ed = document.querySelector('.settings-editor');
          if (!ed || !ed.offsetParent) return null;
          const q = ed.querySelector('.settings-header .suggest-input-container .view-lines');
          const count = ed.querySelector('.settings-count-widget');
          return { query: q ? q.innerText.replace(/\u00a0/g, ' ').trim() : '', found: count ? count.innerText.trim() : '' };
        });
        return x && /^5 Settings Found$/.test(x.found) && x;
      }, 20000, 500);
      check(!!settings && settings.query === `@id:${CODEX_SWITCHES.join(',')}`,
        'and opens the Settings editor on the stand-in extension\'s five feature settings', settings || await page.evaluate(() => !!document.querySelector('.settings-editor')));
      await look('token-mode-custom', { expect: 'The Settings editor in front, its search box holding @id: followed by five codexPlus setting ids, 5 Settings Found, and below it five settings of Codex Plus, each a ticked checkbox: Conversation Brief, Detached End Notices, Tell Codex Your Time Zone, Wake Ups and Work Plan.' });
      /* The Settings editor covers the whole window, and hovering the status bar does nothing until it closes. */
      await page.keyboard.press('Escape');
      await exec('workbench.action.closeActiveEditor');
      await openNotes();
      check(!!await tipIs(tipFor('Custom', ALL_FEATURES, [])), 'in Custom, with every feature setting at its default, the hover lists every feature', await tip());
      await setting('codexPlus.wakeUps', false);
      check(!!await tipIs(tipFor('Custom', ALL_FEATURES.filter((f) => f !== 'wake-ups'), ['wake-ups'])), 'and a feature turned off there is left out', await tip());
      await unhover();
    } finally {
      await setting('codexPlus.wakeUps', undefined);
      await setting('agentPlus.tokenMode', undefined);
    }
    check(!!await until(async () => { const e = await entry('tokenMode'); return e && e.text === 'All'; }, 5000, 200), 'with the setting removed the mode is All, the default', await entry('tokenMode'));
    await openNotes();
  });

  /* ── the view settings and Show Status ── */
  await step('view-settings', async () => {
    await startWorking([conv('run', 'Running a turn', 'working', 'working'), conv('s-wait', 'Still waits', 'prompt', 'waiting')]);
    await setting('agentPlus.workPlanView', false);
    const gone = await until(async () => !await page.evaluate((re) => [...document.querySelectorAll('.activitybar .action-item .action-label')].some((a) => new RegExp(re).test(a.getAttribute('aria-label') || '')), PLAN_ENTRY), 10000, 300);
    check(!!gone, 'with agentPlus.workPlanView off, the Work plan view goes, and with it the Agent Plus side bar');
    await setting('agentPlus.workPlanView', true);
    await showPlanView();
    check(!!await until(async () => !!await planRows() || !!await welcome('agentPlus.workPlan'), 10000, 300), 'turned back on, it is there again');
    await setting('agentPlus.conversationsView', false);
    const off = await until(async () => {
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.part.panel .composite-bar .action-label')].map((a) => (a.getAttribute('aria-label') || a.innerText || '').trim()));
      return !tabs.some((t) => /^Conversations/.test(t)) && tabs;
    }, 10000, 300);
    check(!!off, 'with agentPlus.conversationsView off, the Conversations and Answer views go', off);
    check((await bell()) === 1, 'while the status bar entry still counts the conversation waiting', await entry('conversations'));
    await look('view-settings-off', { expect: 'No Conversations tab in the panel; the status bar has 1 conversation needs you in the bar\'s own colours and the token mode entry All.' },
      page.locator('#workbench\\.parts\\.statusbar'));
    await setting('agentPlus.conversationsView', true);
    await showConversations();
    check(!!await until(async () => !!await convRows() && !!await entry('conversations'), 10000, 300), 'turned back on, the Conversations view and its status bar entry are back');
    await sleep(2000);
    const missingCsp = walk(path.join(profile.user, 'logs')).filter((f) => /exthost\.log$/.test(f) && fs.statSync(f).mtimeMs > launchedAt)
      .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')).filter((l) => /xnervwang\.agent-plus created a webview without a content security policy/.test(l));
    check(!missingCsp.length, 'and VS Code reports no missing content security policy for the Answer view it builds again', missingCsp);
    await startWorking([conv('quiet', 'Nothing to see', 'idle', 'stopped')]);
  });

  /* ── the session list ── */
  const slFrame = () => until(async () => {
    for (const f of page.frames()) { try { if (await f.evaluate(() => !!document.querySelector('.sl-root .sl-new'))) return f; } catch (_) { /* not that frame */ } }
    return null;
  }, 20000, 300);
  let sl = null;
  /* Shows the session list's container and finds its page; `view` is the view's id, under that name because the feature
     list check looks for it. */
  const showSessions = async (view) => {
    await exec('workbench.view.extension.agentPlusSessions');
    await sleep(500);
    sl = await slFrame();
    if (!sl) throw new Error(`the page of ${view} did not load`);
    return sl;
  };
  const slRows = () => sl.evaluate(() => [...document.querySelectorAll('.sl-row')].map((r) => ({ title: r.querySelector('.sl-title').textContent,
    section: r.closest('.sl-section').dataset.key, label: r.closest('.sl-section').querySelector('.sl-head-label').textContent, dot: r.dataset.dot,
    stripe: r.dataset.stripe, dim: r.classList.contains('sl-elsewhere'), shown: !!r.offsetParent && !r.closest('.sl-hidden'),
    pinned: !r.querySelector('.sl-pinned').classList.contains('sl-hidden'), color: r.querySelector('.sl-title').style.color, indent: r.style.paddingLeft,
    marks: r.querySelector('.sl-marks').textContent })));
  const slWait = (fn, ms = 15000) => until(async () => { const r = await slRows().catch(() => null); return r && fn(r) ? r : null; }, ms, 300);
  const slFind = (rows, title, section) => (rows || []).find((r) => r.title === title && (!section || r.section === section));
  const slRowLoc = (title, section) => sl.locator(section ? `.sl-section[data-key="${section}"] .sl-row` : '.sl-section:not([data-key="closed"]) .sl-row')
    .filter({ has: sl.locator('.sl-title', { hasText: new RegExp(`^${escapeRe(title)}$`) }) }).first();
  const slHead = (label) => sl.locator('.sl-head').filter({ has: sl.locator('.sl-head-label', { hasText: new RegExp(`^${escapeRe(label)}$`, 'i') }) }).first();
  const slOpen = async (label) => { const h = slHead(label); if (!await h.evaluate((e) => e.parentElement.classList.contains('sl-open'))) await h.click(); };
  const slMenu = () => until(() => sl.evaluate(() => {
    const b = document.querySelector('.sl-ctx:not(.sl-ctx-sub)');
    return b ? [...b.querySelectorAll('.sl-ctx-item')].map((x) => x.textContent.replace('›', '').replace('✓', '').trim()) : null;
  }), 5000, 200);
  /* Escape closes only the innermost menu, and a submenu the pointer opened may be up too, so it is pressed until none
     is left. */
  const slClose = async () => { for (let i = 0; i < 4 && await sl.evaluate(() => !!document.querySelector('.sl-ctx')); i++) await page.keyboard.press('Escape'); };
  const slItem = (label, sub = false) => sl.locator(sub ? '.sl-ctx-sub .sl-ctx-item' : '.sl-ctx:not(.sl-ctx-sub) .sl-ctx-item').filter({ hasText: label }).first();
  const slAct = async (title, act, section) => { const r = slRowLoc(title, section); await r.hover(); await r.locator(`.sl-act[data-act="${act}"]`).click(); await page.mouse.move(5, 5); };
  const slHover = () => sl.evaluate(() => { const h = document.querySelector('.sl-hover'); return h && !h.classList.contains('sl-hidden') ? h.textContent : ''; });
  const calls = (which) => src(which === 'codex' ? 'return src.state.calls;' : 'return src.otherState(arg).calls;', which);
  const sidebarBox = () => page.locator('#workbench\\.parts\\.sidebar');
  /* Parses a colour from getComputedStyle into [r, g, b, a], with r, g, b in 0-255. It reads rgb(), rgba() and
     color(srgb ...), which a color-mix() computes to; anything else gives null. */
  const rgbaOf = (css) => {
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(css || '');
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(css || '');
    return m ? [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]] : null;
  };
  const luminance = (c) => c.slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100; };
  const rgbOf = (c) => (c ? c.slice(0, 3).map(Math.round) : null);
  /* `fx` and `fy` place the point in `loc`'s box: a fraction of the box's width or height when below 1, a number of CSS
     pixels from its left or top edge otherwise. */
  const pixelOf = async (loc, fx = 0.5, fy = 0.5) => {
    const b = await loc.boundingBox().catch(() => null);
    if (!b) return null;
    const x = b.x + (fx < 1 ? b.width * fx : fx), y = b.y + (fy < 1 ? b.height * fy : fy);
    const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } }).catch(() => null);
    if (!png) return null;
    const img = pixels.decode(png);
    return [img.data[0], img.data[1], img.data[2]];
  };
  const slTheme = async (name) => { await theme(name); await showSessions('agentPlus.sessions'); await sleep(800); };
  /* Puts the pointer on the blank top edge of the list's page, above the New bar: off the sections and every control.
     Moving it out of the page, to the window's corner for instance, would not do: the page is not told the pointer
     left, so its hover stays where it was. */
  const slAway = async () => { await sl.locator('.sl-top').hover({ position: { x: 2, y: 2 } }).catch(() => {}); await sleep(200); };
  /*
   * The two activity bar entries, Agent Plus - Conversations for the session list and Agent Plus for the Work plan, once
   * both are drawn. Null while either is missing or has no size yet.
   */
  const barEntries = () => page.evaluate(([sessionsRe, planRe]) => {
    const items = [...document.querySelectorAll('.activitybar .action-item')];
    const find = (re) => {
      const i = items.findIndex((x) => { const l = x.querySelector('.action-label'); return !!l && re.test(l.getAttribute('aria-label') || ''); });
      if (i < 0) return null;
      const r = items[i].getBoundingClientRect(), s = getComputedStyle(items[i].querySelector('.action-label'));
      return r.width > 0 && r.height > 0 ? { index: i, x: r.x, y: r.y, width: r.width, height: r.height, icon: `${s.maskImage || ''} ${s.webkitMaskImage || ''}` } : null;
    };
    const sessions = find(new RegExp(sessionsRe)), plan = find(new RegExp(planRe));
    return sessions && plan ? { sessions, plan } : null;
  }, [SESSIONS_ENTRY, PLAN_ENTRY]);
  const barShown = () => until(barEntries, 15000, 200);
  const barBox = (b) => {
    const top = Math.min(b.sessions.y, b.plan.y), bottom = Math.max(b.sessions.y + b.sessions.height, b.plan.y + b.plan.height);
    const left = Math.min(b.sessions.x, b.plan.x), right = Math.max(b.sessions.x + b.sessions.width, b.plan.x + b.plan.width);
    return { x: left, y: top - 8, width: right - left, height: bottom - top + 16 };
  };
  /* What both close views of the two entries should show, after the theme's own words. */
  const BAR_LOOK = 'on top the robot of the Conversations session list (a speech-bubble head with two square eyes, a small ear on each side and an antenna ending in a ring), and right under it the Work plan of Agent Plus (a page with a folded corner, a tick and a list). The two icons look the same size and line weight: the robot\'s head is about as wide as the page and the whole robot about as tall. The robot\'s entry is the active one, so it is the brighter of the two and may have a marker line at its left edge. Neither icon is cut off, and nothing but a number badge covers either.';
  const DAY = 86400e3;
  /* A stand-in for another VS Code window: an entry in each source's windows/<pid>.json, with this test's own process
     as the window. */
  const otherWindow = (sessions) => {
    fs.mkdirSync(path.join(profile.plans, 'windows'), { recursive: true });
    fs.writeFileSync(path.join(profile.plans, 'windows', `${process.pid}.json`), JSON.stringify({ at: Date.now(), pid: process.pid, name: 'proj-b [SSH: host-b]', sessions }));
  };
  const SLT = { run: 'Fix the sessions page filter', bg: 'Background build left running', perm: 'Waits for a permission', ask: 'Asked which branch to release',
    askrun: 'Asked a question, still working', unread: 'Review archive sweep', other: 'Open in another window', quiet: 'Nothing going on', kid: 'A sub-agent',
    month: 'Quiet for a month', weeks: 'Quiet for three weeks', cc: 'A Claude Code conversation', ccStop: 'Claude Code, stopped', oc: 'An OpenCode conversation',
    ocTerm: 'OpenCode in a terminal', ocOld: 'Archived long ago' };
  let slAt = 0;
  const slConvs = (t) => [
    conv('sl-run', SLT.run, 'working', 'working', false, { lastActiveAt: t - 60e3, actions: ['goal.pause'] }),
    conv('sl-bg', SLT.bg, 'working', 'background', false, { lastActiveAt: t - 120e3 }),
    conv('sl-perm', SLT.perm, 'prompt', 'waiting', false, { lastActiveAt: t - 180e3, waitingFor: { kind: 'permission', tool: 'Bash' } }),
    conv('sl-ask', SLT.ask, 'idle', 'stopped', false, { running: false, lastActiveAt: t - 240e3, lastUserAt: t - HOUR }),
    conv('sl-askrun', SLT.askrun, 'working', 'working', false, { lastActiveAt: t - 300e3, lastUserAt: t - HOUR }),
    conv('sl-unread', SLT.unread, 'unread', 'stopped', true, { running: false, lastActiveAt: t - 360e3 }),
    conv('sl-other', SLT.other, 'idle', 'stopped', false, { running: false, lastActiveAt: t - 420e3 }),
    conv('sl-quiet', SLT.quiet, 'idle', 'stopped', false, { running: false, lastActiveAt: t - 480e3 }),
    conv('sl-kid', SLT.kid, 'idle', 'stopped', false, { running: false, kind: 'subagent', parentId: 'sl-run', lastActiveAt: t - 500e3 }),
    conv('sl-month', SLT.month, 'idle', 'stopped', false, { running: false, lastActiveAt: t - 30 * DAY }),
    conv('sl-weeks', SLT.weeks, 'idle', 'stopped', false, { running: false, lastActiveAt: t - 21 * DAY, worktree: 'feature-x', processes: 2 }),
  ];
  const slPlans = (t) => {
    for (const id of ['sl-ask', 'sl-askrun']) writePlan(id, { nodes: [{ title: 'Pick the branch', state: 'waiting', waitingOn: 'user', question: 'Main or the hotfix branch?', since: iso(t - 60e3), opened: iso(t - HOUR) }] });
  };

  /* Whether the session list has made its first pass over the project, which archives anything already due. */
  const listSwept = () => { try { const d = path.join(profile.shared, 'session-list'); return fs.readdirSync(d).filter((n) => /^[0-9a-f]{16}\.json$/.test(n))
    .some((n) => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')).sweepAt > 0); } catch (_) { return false; } };

  await step('sessions-rows', async () => {
    check(!!await until(async () => listSwept(), 30000, 300), 'the session list makes its first pass over the project once the window opens');
    slAt = Date.now();
    slPlans(slAt);
    await conversations(slConvs(slAt));
    await src('return src.addOther(arg);', [conv('cc-1', SLT.cc, 'working', 'working', false, { lastActiveAt: slAt - 90e3 }),
      conv('cc-2', SLT.ccStop, 'idle', 'stopped', false, { running: false, lastActiveAt: slAt - 2 * HOUR })]);
    await src('return src.addThird(arg[0], arg[1]);', [[conv('oc-1', SLT.oc, 'idle', 'stopped', false, { running: false, lastActiveAt: slAt - 150e3 }),
      conv('oc-term', SLT.ocTerm, 'working', 'working', false, { lastActiveAt: slAt - 200e3, elsewhere: [{ kind: 'terminal', label: 'terminal pts/3', detail: ['opencode in /work/expense-tracker'], running: true }] }),
      conv('oc-old', SLT.ocOld, 'idle', 'stopped', false, { running: false, lastActiveAt: slAt - 60 * DAY })],
    { archived: [{ sessionId: 'oc-old', at: slAt - 60 * DAY }], groups: [], pinned: [], colors: {} }]);
    otherWindow(['sl-other']);
    await openConv('sl-run');
    await showSessions('agentPlus.sessions');
    await sideBarWidth(420);
    const bar = await barShown();
    check(!!bar && bar.sessions.index < bar.plan.index && bar.sessions.y + bar.sessions.height <= bar.plan.y + 1
      && /sessions\.svg/.test(bar.sessions.icon) && /sidebar\.svg/.test(bar.plan.icon),
    'in the activity bar the session list\'s entry comes above the Work plan\'s, each with its own icon', bar);
    await look('sessions-activity-bar-dark', { expect: `A close view of two entries of the activity bar on the left, in a dark theme: light icons on the dark bar, ${BAR_LOOK}` },
      bar ? barBox(bar) : null);
    const rows = await slWait((r) => [SLT.run, SLT.perm, SLT.ask, SLT.other, SLT.cc, SLT.oc, SLT.ocTerm].every((t) => slFind(r, t, 'ungrouped'))
      && (slFind(r, SLT.other) || {}).stripe === 'elsewhere' && (slFind(r, SLT.ask) || {}).dot === 'red', 25000);
    check(!!rows, 'the session list shows the conversations of all three agents together, in Ungrouped', rows || await slRows().catch(() => null));
    if (!rows) return;
    const dot = (t) => (slFind(rows, t) || {}).dot;
    check(sameList([SLT.run, SLT.bg, SLT.perm, SLT.ask, SLT.askrun, SLT.quiet].map(dot), ['green', 'greenRing', 'blue', 'red', 'redRing', 'none']),
      'each of the five dots: a turn running, background work only, a dialog waiting, a question asked and stopped, a question asked while still working, and none', [SLT.run, SLT.bg, SLT.perm, SLT.ask, SLT.askrun, SLT.quiet].map((t) => [t, dot(t)]));
    const run = slFind(rows, SLT.run), other = slFind(rows, SLT.other), term = slFind(rows, SLT.ocTerm);
    check(run.stripe === 'here' && !run.dim && other.stripe === 'elsewhere' && other.dim && term.stripe === 'elsewhere' && term.dim && dot(SLT.ocTerm) === 'green',
      'the conversation in this window\'s tab has the solid stripe; one in another VS Code window and one in a terminal have the outlined stripe and are dimmed but keep their dot', [run, other, term]);
    const unreadMark = (t) => sl.evaluate((x) => [...document.querySelectorAll('.sl-row')].some((r) => r.querySelector('.sl-title').textContent === x && !!r.querySelector('.sl-unread svg')), t);
    check(!slFind(rows, SLT.kid) && await unreadMark(SLT.unread) && !await unreadMark(SLT.quiet),
      'a sub-agent is hidden, and only the unread conversation has the envelope', rows.map((r) => [r.title, r.marks]));
    const weeks = slFind(rows, SLT.weeks) || {};
    check(/feature-x/.test(weeks.marks || '') && /· 2 processes/.test(weeks.marks || '') && !/processes/.test((slFind(rows, SLT.quiet) || {}).marks || ''),
      'a conversation in a git worktree has the worktree\'s name on its row, and one open in two processes at once shows the count on its row', weeks);
    const archived = slFind(rows, SLT.ocOld, 'archived');
    check(!!archived, 'what the agent had archived is imported as archived, the first time the list sees that agent', rows.filter((r) => r.section === 'archived'));
    const ungrouped = rows.filter((r) => r.section === 'ungrouped').map((r) => r.title);
    check(ungrouped.indexOf(SLT.run) < ungrouped.indexOf(SLT.cc) && ungrouped.indexOf(SLT.cc) < ungrouped.indexOf(SLT.bg) && ungrouped.indexOf(SLT.weeks) < ungrouped.indexOf(SLT.month),
      'Ungrouped is in order of the last message, newest first, across the agents', ungrouped);
    const chips = await sl.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sl-chip')].map((c) => [c.dataset.chip, Number(c.lastChild.textContent)])));
    check(chips.needs === 3 && chips.running === 5 && chips.open === 1, 'the chips count the blue and both red dots for Needs you, the five running for Running, and the one open here for Open', chips);
    const whole = await sl.evaluate(() => { const s = document.querySelector('.sl-new-half.sl-primary span'); return !!s && s.scrollWidth <= s.clientWidth + 1 && s.textContent; });
    check(whole === 'New in tab', 'the New bar\'s default half shows its whole label', whole);
    const heads = await sl.evaluate(() => [...document.querySelectorAll('.sl-section')].filter((x) => !x.classList.contains('sl-hidden') && x.dataset.key !== 'account')
      .map((x) => [x.dataset.key, Number((x.querySelector('.sl-head-count') || {}).textContent), x.querySelectorAll('.sl-row').length]));
    check(heads.length > 0 && heads.every(([, n, m]) => n === m), 'each section\'s count is the number of rows in it', heads);
    const away = await sl.evaluate(() => [...document.querySelectorAll('.sl-row')].filter((r) => r.querySelector('.sl-away:not(.sl-hidden) svg'))
      .map((r) => [r.querySelector('.sl-title').textContent, r.querySelector('.sl-away').dataset.away]).sort());
    check(sameList(away.map((x) => x.join(':')), [`${SLT.other}:window`, `${SLT.ocTerm}:terminal`].sort()),
      'a row open in another VS Code window ends in a windows icon and one open in a terminal ends in a terminal icon; no other row has one', away);
    await look('sessions-dark', { expect: 'The Conversations side bar of Agent Plus in a dark theme: a New bar (an agent logo with a caret, New in tab highlighted with its whole label, then New in sidebar, or only a side bar icon for it where its label does not fit), chips All, Open 1, Running 5, Needs you 3, then the section bands: no RECENTLY CLOSED, and UNGROUPED with a count (the list goes on below the picture). Rows have a logo (blue square for Codex, orange circle for Claude Code, a dark square for OpenCode) with a coloured dot at its top right where something runs or waits: green, a hollow green ring, blue, red, a hollow red ring. Fix the sessions page filter has a solid deep blue stripe at its start and a blue-tinted background; Open in another window and OpenCode in a terminal have a stripe outlined in that blue and dimmed text. All, the chosen chip, has the colour of VS Code\'s buttons; Open, Running and Needs you are grey. Review archive sweep has a small envelope icon after its title. Quiet for three weeks, if it is in the picture, has a feature-x badge and a red · 2 processes after its title.' },
      sidebarBox());
    await exec('notifications.clearAll');
    await sl.evaluate(() => { const r = [...document.querySelectorAll('.sl-row[data-stripe="elsewhere"]')]; if (r.length) r[r.length - 1].scrollIntoView({ block: 'nearest' }); });
    await sleep(300);
    await look('sessions-elsewhere', { expect: 'A close view of the list. The rows Open in another window and OpenCode in a terminal stand out as open somewhere else at a glance: an outlined stripe at the start of the row, greyed title and logo, and an icon just before the time at the right (two windows on Open in another window, a terminal on OpenCode in a terminal), while the other rows are not greyed and have no such icon. Judge whether that mark is noticeable without being told to look for it.' },
      sidebarBox());
  });

  await step('sessions-themes', async () => {
    needs('sessions-rows');
    await theme(THEMES.light);
    await showSessions('agentPlus.sessions');
    await sleep(800);
    await look('sessions-light', { expect: 'The same list in a light theme: dark text on a light background, section bands a little darker than the rows, the logos and the five dots in the same colours as in the dark theme, and the stripes visible.' }, sidebarBox());
    const bar = await barShown();
    check(!!bar, 'the activity bar still draws both entries in the light theme', bar);
    await look('sessions-activity-bar-light', { expect: `The same two entries of the activity bar in a light theme: dark icons on the light bar, ${BAR_LOOK}` },
      bar ? barBox(bar) : null);
    await theme(THEMES.dark);
    await sideBarWidth(230);
    await showSessions('agentPlus.sessions');
    await sleep(800);
    const over = await sl.evaluate(() => [...document.querySelectorAll('.sl-row')].filter((r) => r.offsetParent && r.scrollWidth > r.clientWidth + 1)
      .map((r) => [r.querySelector('.sl-title').textContent, r.scrollWidth, r.clientWidth]));
    check(!over.length, 'in a narrow side bar every row still fits, its title cut short', over);
    const tight = await sl.evaluate(() => { const b = document.querySelector('.sl-new'), p = b.querySelector('.sl-new-half.sl-primary span'), o = b.querySelector('.sl-new-half:not(.sl-primary) .sl-place');
      return { tight: b.classList.contains('sl-tight'), whole: !!p && p.scrollWidth <= p.clientWidth + 1, icon: !!o && getComputedStyle(o).display !== 'none' }; });
    check(tight.tight && tight.whole && tight.icon, 'and the New bar keeps New in tab whole, showing the other half as a side bar icon', tight);
    await look('sessions-narrow', { expect: 'The list in a narrow side bar, about 230 pixels: long titles end in an ellipsis, the time stays at the right, nothing overlaps, and the New bar stays on one line: New in tab with its whole label, and beside it a small side bar icon in place of New in sidebar.' }, sidebarBox());
    await sideBarWidth(420);
  });

  await step('sessions-title', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    const titleOf = () => page.evaluate(() => { const h = document.querySelector('[id="workbench.parts.sidebar"] .composite.title .title-label h2');
      return h && h.offsetParent ? h.textContent.trim() : null; });
    const title = await until(titleOf, 10000, 300);
    check(title === 'Agent Plus - Conversations', 'the side bar of the session list is titled Agent Plus - Conversations, once, with no view name after it', title);
    /* The activity bar entry's label is drawn under its badge, so the pointer is put on the middle of the entry rather
       than asked to hover the label. */
    const entryBox = await page.locator('.activitybar .action-item').filter({ has: page.locator('.action-label[aria-label^="Agent Plus - Conversations"]') }).first()
      .boundingBox().catch(() => null);
    await page.mouse.move(5, 5);
    await until(async () => !await anyHover(), 3000, 200);
    if (entryBox) await page.mouse.move(entryBox.x + entryBox.width / 2, entryBox.y + entryBox.height / 2, { steps: 4 });
    const said = (await until(() => page.evaluate(() => {
      const h = [...document.querySelectorAll('.monaco-hover, .workbench-hover')].find((e) => e.offsetParent && e.innerText.trim());
      return h ? h.innerText.trim() : '';
    }), 6000, 200)) || '';
    check(/^Agent Plus - Conversations/.test(said), 'and the hover of its activity bar entry says Agent Plus - Conversations', said);
    const barBox = await page.locator('#workbench\\.parts\\.activitybar').boundingBox().catch(() => null);
    await look('sessions-title-hover', { pointer: true, expect: 'The activity bar at the left with the pointer on its robot entry, and to the right of that entry a hover saying Agent Plus - Conversations (a number of conversations needing you may follow it), over the side bar.' },
      barBox ? { x: barBox.x, y: barBox.y, width: barBox.width + 360, height: barBox.height } : null);
    await page.mouse.move(5, 5);
    await look('sessions-title-dark', { expect: 'The top line of the side bar in a dark theme: the title Agent Plus - Conversations (in capitals or not, as the theme draws it) once, with nothing such as ": Conversations" after it, then the search, filter and more buttons at the right.' },
      page.locator('[id="workbench.parts.sidebar"] .composite.title'));
    await slTheme(THEMES.light);
    check(await titleOf() === 'Agent Plus - Conversations', 'the title is the same in a light theme', await titleOf());
    await look('sessions-title-light', { expect: 'The same top line of the side bar in a light theme: Agent Plus - Conversations once, dark text on a light background, and the three buttons at the right.' },
      page.locator('[id="workbench.parts.sidebar"] .composite.title'));
    await slTheme(THEMES.dark);
  });

  /* The stripes and the row in front, measured in each kind of theme. */
  await step('sessions-stripes', async () => {
    needs('sessions-rows');
    otherWindow(['sl-other']);
    await showSessions('agentPlus.sessions');
    const BLUE = { dark: [37, 99, 235], light: [29, 78, 216], hcDark: [48, 112, 240], hcLight: [30, 64, 175] };
    const drawn = async () => {
      await slAway();
      const css = await sl.evaluate(([other, term]) => {
        const row = (t) => [...document.querySelectorAll('.sl-section[data-key="ungrouped"] .sl-row')].find((r) => r.querySelector('.sl-title').textContent === t);
        const st = (e) => (e ? getComputedStyle(e) : null);
        const here = document.querySelector('.sl-section[data-key="ungrouped"] .sl-stripe.s-here'), away = row(other) && row(other).querySelector('.sl-stripe');
        const dot = document.querySelector('.sl-dot.d-blue'), title = row(term) && row(term).querySelector('.sl-title');
        return { here: here && st(here).backgroundColor, away: away && st(away).borderTopColor, awayFill: away && st(away).backgroundColor, awayWidth: away && st(away).borderTopWidth,
          dot: dot && st(dot).backgroundColor, body: st(document.body).backgroundColor, cursorTerm: row(term) && st(row(term)).cursor,
          cursorWindow: row(other) && st(row(other)).cursor, termColor: title && title.style.color, termOpacity: title && st(title).opacity };
      }, [SLT.other, SLT.ocTerm]);
      const cur = await pixelOf(sl.locator('.sl-section[data-key="ungrouped"] .sl-row.sl-current').first(), 0.6, 3);
      const head = await pixelOf(sl.locator('.sl-section[data-key="ungrouped"] > .sl-head'), 0.6, 0.5);
      return { css, cur, head };
    };
    const judge = (which, d, { tint = true } = {}) => {
      const here = rgbaOf(d.css.here), away = rgbaOf(d.css.away), dot = rgbaOf(d.css.dot), body = rgbaOf(d.css.body);
      check(!!here && !!dot && !!body && sameList(rgbOf(here), BLUE[which]) && luminance(here) < luminance(dot) && contrast(here, body) >= 3,
        `${which}: the stripe of the conversation open in this window is a solid blue, deeper than the blue dot of a pending approval, and stands out from the list`,
        { stripe: d.css.here, dot: d.css.dot, body: d.css.body, contrast: here && body ? contrast(here, body) : null });
      check(!!away && sameList(rgbOf(away), BLUE[which]) && (rgbaOf(d.css.awayFill) || [0, 0, 0, 0])[3] === 0 && parseFloat(d.css.awayWidth) >= 1,
        `${which}: a row open somewhere else has a hollow stripe outlined in the same blue as the one open in this window`, d.css);
      if (!tint) return;
      const t = d.cur && d.head ? { distance: Math.round(Math.hypot(...d.cur.map((v, i) => v - d.head[i]))), bluer: (d.cur[2] - d.cur[0]) - (d.head[2] - d.head[0]) } : null;
      check(!!t && t.distance >= 20 && t.bluer >= 15, `${which}: the row in front is tinted blue, apart from the grey band of its section`, { row: d.cur, band: d.head, t });
    };
    const box = async () => {
      const h = await sl.locator('.sl-section[data-key="ungrouped"] > .sl-head').boundingBox().catch(() => null);
      return h ? { x: h.x, y: h.y - 4, width: h.width, height: h.height + 12 * 29 + 8 } : sidebarBox();
    };
    /* A title colour on a row open somewhere else stays, dimmed with the row. */
    await slRowLoc(SLT.ocTerm).click({ button: 'right' });
    await slMenu();
    await slItem('Text Color').hover({ position: { x: 10, y: 8 } });
    await slItem('Purple', true).click();
    await slWait((r) => /charts-purple/.test((slFind(r, SLT.ocTerm) || {}).color || ''));
    let d = await drawn();
    judge('dark', d);
    check(d.css.cursorTerm === 'not-allowed' && d.css.cursorWindow === 'pointer',
      'over a row open in a terminal the pointer is the not-allowed cursor; over one open in another VS Code window it is the usual hand', d.css);
    check(/charts-purple/.test(d.css.termColor || '') && Number(d.css.termOpacity) === 0.45, 'a row open somewhere else keeps its title colour, faded with the rest of the row', d.css);
    await look('sessions-stripes-dark', { expect: 'A close view of the UNGROUPED band and the rows under it, in a dark theme. The band is grey. The first row under it, Fix the sessions page filter, is the conversation in front: its background has a dark blue tint that stands out from the grey band, and it has a solid deep blue stripe at its start, deeper than the blue dot on the logo of Waits for a permission. OpenCode in a terminal and Open in another window (at the bottom, possibly cut off by the edge of the view) have a hollow stripe outlined in that same deep blue and dimmed titles; the title of OpenCode in a terminal is purple, only fainter. The row titled An OpenCode conversation may have a solid grey stripe (closed here lately). No other row has a stripe.' },
      await box());
    await slRowLoc(SLT.ocTerm).click();
    const told = await toastWith('Close it there first', 12000);
    check(!!told && !(await calls('opencode')).some((c) => c[0] === 'open' && c[1][0] === 'oc-term'), 'clicking a row open in a terminal opens nothing here and says where to close it first', told);
    await clearToasts();
    await slTheme(THEMES.light);
    d = await drawn();
    judge('light', d);
    check(Number(d.css.termOpacity) === 0.6, 'in a light theme the title of a row open somewhere else is dimmed a little less', d.css);
    await look('sessions-stripes-light', { expect: 'The same close view in a light theme: a light grey UNGROUPED band, then Fix the sessions page filter on a pale blue background, clearly apart from the band\'s grey, with a solid deep blue stripe, deeper than the blue dot of Waits for a permission. OpenCode in a terminal and Open in another window have hollow stripes outlined in that blue and faded titles, the first of them in purple.' },
      await box());
    await slTheme(THEMES.hcDark);
    d = await drawn();
    judge('hcDark', d, { tint: false });
    check(Number(d.css.termOpacity) === 0.7, 'hcDark: in a high contrast theme the title of a row open somewhere else is faded less, so that it stays readable', d.css);
    await look('sessions-stripes-hc-dark', { expect: 'The same close view in the dark high contrast theme, on black: the stripe of Fix the sessions page filter is a solid blue that is easy to see, the hollow stripes of OpenCode in a terminal and Open in another window are outlined in the same blue, the purple title of OpenCode in a terminal is fainter than the other titles yet still easy to read, and the UNGROUPED band has the theme\'s lines above and below it; the row in front has a dark blue tint.' },
      await box());
    await slTheme(THEMES.hcLight);
    d = await drawn();
    judge('hcLight', d, { tint: false });
    check(Number(d.css.termOpacity) === 0.7, 'hcLight: the light high contrast theme fades it less too', d.css);
    await look('sessions-stripes-hc-light', { expect: 'In the light high contrast theme, on white: a solid dark blue stripe on Fix the sessions page filter, easy to see, hollow stripes of the same blue on OpenCode in a terminal and Open in another window.' },
      await box());
    await slTheme(THEMES.dark);
    await slRowLoc(SLT.ocTerm).click({ button: 'right' });
    await slMenu();
    await slItem('Text Color').hover({ position: { x: 10, y: 8 } });
    await slItem('Default', true).click();
    await slWait((r) => !(slFind(r, SLT.ocTerm) || {}).color);
  });

  /* A row running a turn stays put until the turn ends, and no row moves while the pointer is on the sections or the
     arrow keys are on a row. */
  await step('sessions-order', async () => {
    needs('sessions-rows');
    otherWindow(['sl-other']);
    await showSessions('agentPlus.sessions');
    await slAway();
    const FRESH = 'A conversation started just now';
    const order = async () => (await slRows()).filter((r) => r.section === 'ungrouped').map((r) => r.title);
    const timeOf = (title) => sl.evaluate((t) => { const r = [...document.querySelectorAll('.sl-section[data-key="ungrouped"] .sl-row')].find((x) => x.querySelector('.sl-title').textContent === t);
      return r ? r.querySelector('.sl-time').textContent : null; }, title);
    const before = await order();
    await patch('sl-askrun', { lastActiveAt: Date.now() });
    const came = await until(async () => (await timeOf(SLT.askrun)) === 'now', 10000, 300);
    await sleep(500);
    const during = await order();
    check(!!came && sameList(during, before), 'a row running a turn keeps its place while its messages come in, though its time says now', { before, during });
    await patch('sl-askrun', { state: 'idle', activity: 'stopped', running: false });
    const moved = await until(async () => { const o = await order(); return o[0] === SLT.askrun && o; }, 10000, 300);
    check(!!moved, 'once its turn stops, it moves once, to the place of its last message', moved || await order());

    const held = await order();
    await slRowLoc(SLT.quiet).hover();
    await patch('sl-weeks', { lastActiveAt: Date.now() });
    const seen = await until(async () => (await timeOf(SLT.weeks)) === 'now', 10000, 300);
    await sleep(500);
    const still = await order();
    check(!!seen && sameList(still, held), 'while the pointer rests on a row, a row with a new message keeps its place', { held, still });
    await src('src.set(src.conversations().concat([arg])); return true;', conv('sl-fresh', FRESH, 'idle', 'stopped', false, { running: false, lastActiveAt: Date.now() }));
    const fresh = await slWait((r) => slFind(r, FRESH, 'ungrouped'));
    const withNew = fresh && fresh.filter((r) => r.section === 'ungrouped').map((r) => r.title);
    check(!!withNew && withNew[0] === FRESH && sameList(withNew.filter((t) => t !== FRESH), held), 'and a new conversation still appears, at the top, with the other rows where they were', withNew);
    await look('sessions-order-held', { pointer: true, expect: 'The list, scrolled to show Nothing going on, the row under the pointer: it is highlighted, with its buttons in place of its time (a hover box may show beside it). Near the end of UNGROUPED, Quiet for three weeks shows the time now at its right, yet it is still in its old place under Claude Code, stopped, rather than at the top. The first rows of UNGROUPED may be scrolled out of view.' },
      sidebarBox());
    await slAway();
    const after = await until(async () => { const o = await order(); return o[0] === FRESH && o[1] === SLT.weeks && o; }, 5000, 200);
    check(!!after, 'once the pointer moves off the sections, to the blank strip above the New bar, the rows take the order of their last messages', after || await order());
    await look('sessions-order-after', { expect: 'The list with the pointer gone from the rows. UNGROUPED starts with A conversation started just now; next is Quiet for three weeks, saying now, with its feature-x badge and red · 2 processes; then Asked a question, still working.' },
      sidebarBox());

    await slAway();
    await sl.locator('.sl-root').focus();
    await page.keyboard.press('ArrowDown');
    const keyed = await order();
    await patch('sl-other', { lastActiveAt: Date.now() });
    const seen2 = await until(async () => (await timeOf(SLT.other)) === 'now', 10000, 300);
    await sleep(500);
    check(!!seen2 && sameList(await order(), keyed), 'the rows also stay put while the arrow keys are on a row', await order());
    await page.keyboard.press('Escape');
    const let2 = await until(async () => { const o = await order(); return o[0] === SLT.other && o; }, 5000, 200);
    check(!!let2, 'and after Esc takes the highlight off that row, they take the new order', let2 || await order());

    await src('src.set(src.conversations().filter((c) => c.sessionId !== arg)); return true;', 'sl-fresh');
    await patch('sl-weeks', { lastActiveAt: slAt - 21 * DAY });
    await patch('sl-other', { lastActiveAt: slAt - 420e3 });
    await patch('sl-askrun', { state: 'working', activity: 'working', running: true, lastActiveAt: slAt - 300e3 });
    await slWait((r) => !slFind(r, FRESH) && (slFind(r, SLT.askrun) || {}).dot === 'redRing');
  });

  await step('sessions-hover', async () => {
    needs('sessions-rows');
    otherWindow(['sl-other']);
    await showSessions('agentPlus.sessions');
    await slRowLoc(SLT.other).hover();
    const said = await until(async () => { const t = await slHover(); return /Open in the VS Code window "proj-b \[SSH: host-b\]"/.test(t) && t; }, 5000, 200);
    check(!!said && /Session ID: sl-other/.test(said) && /Ungrouped/.test(said), 'the hover box of a conversation open in another window names that window, the section and the session id', said || await slHover());
    await look('sessions-hover', { pointer: true, expect: 'A hover box next to the row Open in another window (under it, or above it when there is no room below), saying Codex · Ungrouped, the session ID sl-other, when it started and when it was last active on two lines, and Open in the VS Code window "proj-b [SSH: host-b]".' }, sidebarBox());
    await page.mouse.move(5, 5);
    await sleep(300);
    await slRowLoc(SLT.ocTerm).hover();
    const term = await until(async () => { const t = await slHover(); return /Runs in terminal pts\/3/.test(t) && t; }, 5000, 200);
    check(!!term && /opencode in \/work\/expense-tracker/.test(term) && /A turn is running/.test(term), 'and the hover box of one running in a terminal names the terminal, what the agent says of it, and what its dot means', term || await slHover());
    await page.mouse.move(5, 5);
  });

  /* What shows() finds may be in a sidebar or in a tab behind another one that sessionForTab could not match, so the
     hover names the sidebar only when the source's shownIn says so. */
  await step('sessions-place', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    /* The hover box is filled when the pointer enters the row, so each try moves the pointer off the row and back. */
    const placeSaid = async (place, want) => {
      await src('return src.showIn(arg[0], arg[1], arg[2]);', ['opencode', ['oc-1'], place]);
      if (!await slWait((r) => (slFind(r, SLT.oc) || {}).stripe === 'here')) return null;
      let last = '';
      const got = await until(async () => {
        await page.mouse.move(5, 5);
        await sleep(200);
        await slRowLoc(SLT.oc).hover();
        last = await until(async () => { const t = await slHover(); return /Open in this window/.test(t) && t; }, 2000, 100) || '';
        return want(last) && last;
      }, 10000, 300);
      return got || last;
    };
    const plain = (t) => /Open in this window/.test(t) && !/in the sidebar/.test(t);
    const none = await placeSaid({}, plain);
    check(plain(none || ''), 'a conversation that shows() finds, with no place given, gets the solid stripe, and its hover says Open in this window and no place', none || await slHover());
    const side = await placeSaid({ 'oc-1': 'sidebar' }, (t) => /Open in this window, in the sidebar/.test(t));
    check(/Open in this window, in the sidebar/.test(side || ''), 'when shownIn answers sidebar, the hover says Open in this window, in the sidebar', side || await slHover());
    const tab = await placeSaid({ 'oc-1': 'tab' }, plain);
    check(plain(tab || ''), 'and when it answers tab, for a tab sessionForTab could not match, the hover does not name the sidebar', tab || await slHover());
    await page.mouse.move(5, 5);
    await src('return src.showIn(arg[0], arg[1], arg[2]);', ['opencode', [], {}]);
    check(!!await slWait((r) => (slFind(r, SLT.oc) || {}).stripe !== 'here'), 'once the source no longer shows it, the row is not open here');
  });

  /* A source can learn a tab's conversation after the tab opened, and reports it with onDidFocus only. */
  await step('sessions-late-tab', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    check(!!await slWait((r) => (slFind(r, SLT.run) || {}).stripe === 'here'), 'the conversation in its tab is open here');
    await src('return src.forgetTab(arg);', 'sl-run');
    check(!!await slWait((r) => (slFind(r, SLT.run) || {}).stripe !== 'here'), 'while its source answers \'\' for its tab, the row is not open here');
    const at = Date.now();
    await src('return src.knowTab(arg);', 'sl-run');
    const back = await slWait((r) => (slFind(r, SLT.run) || {}).stripe === 'here', 5000);
    check(!!back, 'once the source learns the tab\'s conversation and fires onDidFocus, the row is open here again within seconds rather than at the list\'s next 30-second check', `${Date.now() - at} ms`);
    if (!back) await src('return src.knowTab(arg);', 'sl-run');
  });

  await step('sessions-actions', async () => {
    needs('sessions-rows');
    otherWindow(['sl-other']);
    await showSessions('agentPlus.sessions');
    await slAct(SLT.quiet, 'pin');
    const pinned = await slWait((r) => (slFind(r, SLT.quiet) || {}).pinned && r.filter((x) => x.section === 'ungrouped')[0].title === SLT.quiet);
    check(!!pinned, 'the pin button on a row pins it, and pinned conversations go first in their section', pinned && pinned.filter((x) => x.section === 'ungrouped').slice(0, 3));
    await slAct(SLT.unread, 'rename');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Review the archive sweep');
    await page.keyboard.press('Enter');
    const renamed = await until(async () => (await src('return src.conversations();')).some((c) => c.sessionId === 'sl-unread' && c.title === 'Review the archive sweep'), 10000, 300);
    check(!!renamed && !!await slWait((r) => slFind(r, 'Review the archive sweep')), 'Rename edits the title in place, and the agent is asked to rename it');
    await slRowLoc(SLT.quiet).click({ button: 'right' });
    const menu = await slMenu();
    check(!!menu && ['Open in Tab', 'Rename', 'Text Color', 'Unpin', 'New Group from Conversation', 'Mark as Unread', 'Archive'].every((x) => menu.includes(x))
      && !menu.includes('Add to Group') && !menu.includes('Delete...'),
    'a row\'s menu offers to open, rename, set a text colour, unpin, make a new group, mark unread and archive; it has no Add to Group while there is no group, and no Delete outside Archived', menu);
    await slItem('Text Color').click();
    await slItem('Green', true).click();
    check(!!await slWait((r) => /charts-green/.test((slFind(r, SLT.quiet) || {}).color || '')), 'Text Color colours the title');
    await slRowLoc(SLT.run).click({ button: 'right' });
    const own = await slMenu();
    check(!!own && own.includes('Pause Goal'), 'an agent\'s own action is in the menu of the rows it names', own);
    await slItem('Pause Goal').click();
    check(!!await until(async () => (await calls('codex')).some((c) => c[0] === 'goal.pause' && sameList(c[1], ['sl-run'])), 8000, 300), 'and goes to that agent');
    await slRowLoc(SLT.ask).click();
    check(!!await frontIs(SLT.ask), 'clicking a conversation opens it in a tab');
    await slRowLoc(SLT.other).click();
    const told = await toastWith('which did not answer', 12000);
    check(!!told && !(await calls('codex')).some((c) => c[0] === 'open' && c[1][0] === 'sl-other'),
      'a conversation open in another window that does not answer is not also opened here, and a message says so', told);
    await clearToasts();
    await slRowLoc(SLT.quiet).click({ modifiers: ['ControlOrMeta'] });
    await slRowLoc(SLT.cc).click({ modifiers: ['ControlOrMeta'] });
    await slRowLoc(SLT.cc).click({ button: 'right' });
    const many = await slMenu();
    check(!!many && many.includes('Archive 2 Conversations') && many.includes('New Group from 2 Conversations'),
      'Ctrl or Cmd and a click selects several conversations, of any agents, and the menu acts on them all', many);
    await slClose();
    await page.keyboard.press('Escape');
    check(!!await until(() => sl.evaluate(() => !document.querySelector('.sl-row.sl-selected')), 5000, 200), 'and Esc clears the selection');
    await sl.locator('.sl-root').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const hl = await sl.evaluate(() => { const r = document.querySelector('.sl-row.sl-hl'); return r && r.querySelector('.sl-title').textContent; });
    await page.keyboard.press('F2');
    const editingKey = await until(() => sl.evaluate(() => !!document.querySelector('.sl-title.sl-editing')), 5000, 200);
    await page.keyboard.press('Escape');
    check(!!hl && !!editingKey, 'the arrow keys move through the rows, and F2 renames the one they are on', hl);
    await slAct(SLT.quiet, 'archive');
    const arch = await slWait((r) => slFind(r, SLT.quiet, 'archived') && !slFind(r, SLT.quiet, 'ungrouped'));
    check(!!arch && !slFind(arch, SLT.quiet, 'archived').pinned, 'Archive moves it to Archived and unpins it', arch && slFind(arch, SLT.quiet));
    await slOpen('Archived');
    await sl.evaluate(() => { const r = [...document.querySelectorAll('.sl-section[data-key="archived"] .sl-row')]; if (r.length) r[r.length - 1].scrollIntoView({ block: 'nearest' }); });
    await sleep(300);
    await look('sessions-archived', { expect: 'The ARCHIVED section expanded under Ungrouped, listing Nothing going on (green title, no pin) and Archived long ago with the dark OpenCode logo.' }, sidebarBox());
    await slAct(SLT.quiet, 'unarchive', 'archived');
    check(!!await slWait((r) => slFind(r, SLT.quiet, 'ungrouped')), 'Unarchive puts it back in Ungrouped');
  });

  let slGroup = '';
  await step('sessions-groups', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    await exec('agentPlus.newSessionGroup');
    const editing = await until(() => sl.evaluate(() => !!document.querySelector('.sl-head-label.sl-editing')), 8000, 200);
    check(!!editing, 'New Group makes a group and puts its name up for editing');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Plugins');
    await page.keyboard.press('Enter');
    const made = await until(() => sl.evaluate(() => { const s = [...document.querySelectorAll('.sl-section[data-kind="group"]')].find((x) => x.querySelector('.sl-head-label').textContent === 'Plugins'); return s && s.dataset.key; }), 8000, 200);
    check(!!made, 'and the group gets the name typed', made);
    slGroup = made || '';
    await slRowLoc(SLT.cc).click({ button: 'right' });
    await slItem('Add to Group').click();
    await slItem('Plugins', true).click();
    check(!!await slWait((r) => slFind(r, SLT.cc, slGroup)), 'Add to Group moves a conversation of any agent into it');
    await slRowLoc(SLT.perm).dragTo(slHead('Plugins'));
    const dragged = await slWait((r) => slFind(r, SLT.perm, slGroup), 8000);
    check(!!dragged, 'and so does dragging a row onto the group', dragged && dragged.filter((x) => x.section === slGroup));
    await slHead('Plugins').click({ button: 'right' });
    const gm = await slMenu();
    check(!!gm && ['New Conversation in This Group', 'New Group', 'Rename Group', 'Delete Group'].every((x) => gm.includes(x)), 'a group\'s menu offers a new conversation in it, a new group, renaming and deleting it', gm);
    await slItem('New Conversation in This Group').click();
    await look('sessions-menu', { pointer: true, expect: 'The PLUGINS group\'s right-click menu with its first item, New Conversation in This Group, opened, and a submenu listing Codex, Claude Code and OpenCode, each with its logo. Where there is room, the submenu is beside the menu, which shows New Group, Rename Group and Delete Group, and does not cover the item it belongs to. In a side bar too narrow for that, the submenu lies over the right part of the menu, with the start of New Conversation in This Group still in view to its left. If even that does not fit, the submenu replaces the menu, under a first line ‹ New Conversation in This Group, with nothing of the menu showing through.' }, sidebarBox());
    const placed = await sl.evaluate(() => {
      const sub = document.querySelector('.sl-ctx-sub'), item = document.querySelector('.sl-ctx:not(.sl-ctx-sub) .sl-ctx-open');
      if (!sub || !item) return null;
      const a = sub.getBoundingClientRect(), b = item.getBoundingClientRect();
      const covers = a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom && a.bottom > b.top;
      return { inPlace: !!sub.querySelector('.sl-ctx-back'), covers, uncovered: covers ? Math.round(Math.max(a.left - b.left, b.right - a.right)) : Math.round(b.width) };
    });
    if (placed && placed.inPlace) {
      await sl.locator('.sl-ctx-back').click();
      const backTo = await until(() => sl.evaluate(() => { const m = document.querySelector('.sl-ctx:not(.sl-ctx-sub)'); return !document.querySelector('.sl-ctx-sub') && m && m.style.visibility !== 'hidden'
        && [...m.querySelectorAll('.sl-ctx-item')].map((b) => b.textContent.replace('›', '').trim()); }), 5000, 200);
      check(!!backTo && ['New Group', 'Rename Group', 'Delete Group'].every((x) => backTo.includes(x)),
        'in a side bar too narrow for the submenu to sit beside the menu, the submenu replaces the menu, and its first line leads back to it', backTo);
    } else {
      check(!!placed && (!placed.covers || placed.uncovered >= 40), 'a submenu opens beside its menu without covering its item, or, with no room there, covers part of the menu but not the start of its item', placed);
    }
    await slClose();
    /* Leave through the chips at the top, which are not a row: the webview keeps the pointer's last position, and once
       the menu goes the row under it would take the hover. */
    await sl.locator('.sl-chips').hover({ position: { x: 1, y: 1 } });
    await page.mouse.move(5, 5);
    await sl.evaluate(() => { const g = document.querySelector('.sl-section[data-key^="group:"]'); if (g) g.scrollIntoView({ block: 'start' }); });
    await sleep(300);
    await look('sessions-groups', { expect: 'At the top, a PLUGINS section (a folder icon, count 2) holding Waits for a permission and A Claude Code conversation, then UNGROUPED below it; each section header is a band with a line above and below.' }, sidebarBox());
    await slHead('Plugins').click({ button: 'right' });
    await slItem('Delete Group').click();
    check(!!await slWait((r) => slFind(r, SLT.cc, 'ungrouped') && slFind(r, SLT.perm, 'ungrouped')), 'Delete Group puts its conversations back in Ungrouped');
  });

  /* Row menu submenus: resting the pointer on their item opens one, leaving the item and the submenu closes it, and the
     right arrow key and Enter still open it. */
  await step('sessions-submenus', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    const subItems = () => sl.evaluate(() => { const b = document.querySelector('.sl-ctx-sub'); return b ? [...b.querySelectorAll('.sl-ctx-item')].map((x) => x.textContent.trim()) : null; });
    const placed = () => sl.evaluate(() => {
      const sub = document.querySelector('.sl-ctx-sub'), item = document.querySelector('.sl-ctx:not(.sl-ctx-sub) .sl-ctx-open');
      if (!sub || !item) return null;
      const a = sub.getBoundingClientRect(), b = item.getBoundingClientRect();
      const covers = a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom && a.bottom > b.top;
      return { inPlace: !!sub.querySelector('.sl-ctx-back'), covers, uncovered: covers ? Math.round(Math.max(a.left - b.left, b.right - a.right)) : Math.round(b.width), width: innerWidth };
    });
    const menuOn = async (title) => { await page.mouse.move(5, 5); await slRowLoc(title).click({ button: 'right' }); return slMenu(); };
    /* START is a point near the start of an item, which a submenu laid over the menu leaves in view. offBoth moves the
       pointer away from both menus without scrolling the list, which would close them. */
    const START = { position: { x: 10, y: 8 } };
    const offBoth = async () => {
      const m = await sl.locator('.sl-ctx:not(.sl-ctx-sub)').boundingBox().catch(() => null);
      const v = await sidebarBox().boundingBox().catch(() => null);
      if (!m || !v) return;
      const y = m.y - 10 > v.y + 40 ? m.y - 10 : m.y + m.height + 10;
      await page.mouse.move(m.x + 12, y, { steps: 4 });
    };
    await exec('agentPlus.newSessionGroup');
    await until(() => sl.evaluate(() => !!document.querySelector('.sl-head-label.sl-editing')), 8000, 200);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Hover group');
    await page.keyboard.press('Enter');
    await until(() => sl.evaluate(() => [...document.querySelectorAll('.sl-section[data-kind="group"] .sl-head-label')].some((x) => x.textContent === 'Hover group')), 8000, 200);
    for (const [label, want] of [['Text Color', 'Green'], ['Add to Group', 'Hover group']]) {
      await menuOn(SLT.quiet);
      await slItem(label).hover(START);
      const items = await until(subItems, 3000, 100);
      check(!!items && items.some((x) => x.includes(want)), `resting the pointer on ${label} opens its submenu`, items);
      const where = await placed();
      check(!!where && !where.inPlace && (!where.covers || where.uncovered >= 40), `${label}'s submenu sits beside the menu, or over part of it with ${label} still showing at its left`, where);
      if (label === 'Text Color') {
        await look('sessions-submenu-dark', { pointer: true, expect: 'A row\'s right-click menu in a dark theme with the pointer resting on Text Color, which is highlighted, and its submenu open without a click: Default, then the colours Red, Blue, Green, Yellow, Purple, Orange, Pink and Cyan, each with a round swatch. The submenu sits beside the menu, or, in a side bar too narrow for that, covers the right part of the menu while the start of Text Color stays visible at its left.' },
          sidebarBox());
      }
      await offBoth();
      const shut = await until(() => sl.evaluate(() => !document.querySelector('.sl-ctx-sub') && !!document.querySelector('.sl-ctx')), 3000, 100);
      check(!!shut, `moving the pointer off both ${label} and its submenu closes the submenu and leaves the menu open`);
      await slClose();
    }
    await menuOn(SLT.quiet);
    /* The menu opens under the pointer, and a pointer moved out of the window leaves the page thinking it is still on
       one of the items: the next change of layout gives that item a mouseover, which takes the focus from the keys and
       closes a submenu they opened. */
    await offBoth();
    await sleep(300);
    /* A key reaches the webview a moment after page.keyboard.press() returns, so each press waits for the focus to move
       before the focused item is read again; reading at once can count one item twice and press past the item being
       looked for. */
    const focused = () => sl.evaluate(() => { const a = document.activeElement; return a && a.closest && a.closest('.sl-ctx-item') ? a.textContent.replace('›', '').trim() : ''; });
    const focusOn = async (label) => {
      for (let i = 0; i < 20; i++) {
        const at = await focused();
        if (at === label) return true;
        await page.keyboard.press('ArrowDown');
        await until(async () => (await focused()) !== at || null, 2000, 50);
      }
      return false;
    };
    const subFocus = () => sl.evaluate(() => { const b = document.querySelector('.sl-ctx-sub'); return b && b.contains(document.activeElement) ? document.activeElement.textContent.trim() : ''; });
    const onText = await focusOn('Text Color');
    await page.keyboard.press('ArrowRight');
    const byRight = await until(subFocus, 3000, 100);
    check(onText && byRight === 'Default', 'the right arrow key on Text Color opens its submenu, on its first item', byRight);
    await page.keyboard.press('ArrowLeft');
    const back = await until(() => sl.evaluate(() => !document.querySelector('.sl-ctx-sub') && document.activeElement && document.activeElement.textContent.replace('›', '').trim()), 3000, 100);
    check(back === 'Text Color', 'the left arrow key closes it again, back on Text Color', back);
    await page.keyboard.press('Enter');
    check(await until(subFocus, 3000, 100) === 'Default', 'and Enter opens it as well');
    await slClose();
    await sideBarWidth(230);
    await showSessions('agentPlus.sessions');
    await menuOn(SLT.quiet);
    await slItem('Text Color').hover(START);
    const narrow = await until(async () => { const p = await placed(); return p && p; }, 3000, 100);
    check(!!narrow && !narrow.inPlace && (!narrow.covers || narrow.uncovered >= 40), 'in a narrow side bar, resting the pointer on Text Color opens its submenu too, laid over the menu but clear of the start of Text Color', narrow);
    await look('sessions-submenu-narrow', { pointer: true, expect: 'In a narrow side bar, a row\'s menu with the pointer on Text Color and its submenu of colours open over the right part of the menu: the first letters of Text Color, highlighted, show at the left of the submenu, as do those of the items under it.' },
      sidebarBox());
    await slItem('Pin').hover({ position: { x: 8, y: 6 } });
    check(!!await until(() => sl.evaluate(() => !document.querySelector('.sl-ctx-sub')), 3000, 100), 'and moving the pointer onto the part of another item still in view closes it');
    await slClose();
    await sideBarWidth(420);
    await slTheme(THEMES.light);
    await menuOn(SLT.quiet);
    await slItem('Add to Group').hover(START);
    await until(subItems, 3000, 100);
    await look('sessions-submenu-light', { pointer: true, expect: 'The same right-click menu in a light theme, this time on Add to Group: highlighted under the pointer, with its submenu open without a click and listing Hover group, beside the menu or over its right part with the start of Add to Group in view.' },
      sidebarBox());
    await slClose();
    await slTheme(THEMES.dark);
    await page.mouse.move(5, 5);
    await slHead('Hover group').click({ button: 'right' });
    await slItem('Delete Group').click();
    await until(() => sl.evaluate(() => ![...document.querySelectorAll('.sl-section[data-kind="group"] .sl-head-label')].some((x) => x.textContent === 'Hover group')), 8000, 200);
  });

  await step('sessions-delete', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    await slRowLoc(SLT.ccStop).click({ button: 'right' });
    await slItem('Archive').click();
    await slOpen('Archived');
    await slWait((r) => slFind(r, SLT.ccStop, 'archived'));
    await slRowLoc(SLT.ccStop, 'archived').click({ button: 'right' });
    const m = await slMenu();
    check(!!m && m.includes('Delete...'), 'an archived conversation\'s menu offers Delete', m);
    await slItem('Delete...').click();
    const d = await until(dialog, 8000, 200);
    check(!!d && /Delete "Claude Code, stopped" from disk\?/.test(d.text) && /cannot be undone/.test(d.text), 'deleting asks first, naming the conversation and saying it cannot be undone', d);
    await look('sessions-delete-confirm', { expect: 'A VS Code confirmation dialog: Delete "Claude Code, stopped" from disk?, a line naming it with (Claude Code), the line "This cannot be undone.", and Delete and Cancel buttons.' },
      page.locator('.monaco-dialog-box').first());
    await page.locator('.monaco-dialog-box .dialog-buttons .monaco-button').filter({ hasText: /^Delete$/ }).first().click();
    const gone = await until(async () => (await calls('claude-code')).some((c) => c[0] === 'delete' && sameList(c[1], ['cc-2'])), 8000, 300);
    check(!!gone && !!await slWait((r) => !slFind(r, SLT.ccStop)), 'and on Delete the agent deletes it and it leaves the list');
    otherWindow(['sl-other']);
    await slRowLoc(SLT.other).click({ button: 'right' });
    await slItem('Archive').click();
    await slWait((r) => slFind(r, SLT.other, 'archived'));
    await slRowLoc(SLT.other, 'archived').click({ button: 'right' });
    const m2 = await slMenu();
    check(!!m2 && !m2.includes('Delete...'), 'one open in another window cannot be deleted: its menu has no Delete', m2);
    await slClose();
    await slAct(SLT.other, 'unarchive', 'archived');
  });

  await step('sessions-closed', async () => {
    needs('sessions-rows');
    await openConv('sl-quiet');
    await frontIs(SLT.quiet);
    await src('return src.close(arg);', 'sl-quiet');
    await showSessions('agentPlus.sessions');
    const closed = await slWait((r) => slFind(r, SLT.quiet, 'closed') && (slFind(r, SLT.quiet, 'ungrouped') || {}).stripe === 'closed');
    check(!!closed, 'a conversation whose tab closes is in Recently closed, and its row in its own section gets the stripe for closed here lately', closed && closed.filter((r) => r.title === SLT.quiet));
    await slOpen('Recently closed');
    const time = await sl.evaluate(() => { const r = document.querySelector('.sl-section[data-key="closed"] .sl-row .sl-time'); return r && r.textContent; });
    check(/^closed (now|\d+m)$/.test(time || ''), 'and says when it was closed', time);
    const grey = await sl.evaluate(() => { const s = document.querySelector('.sl-section[data-key="closed"] .sl-row .sl-stripe.s-closed'); return s ? getComputedStyle(s).backgroundColor : null; });
    const g = rgbaOf(grey);
    check(!!g && Math.max(...g.slice(0, 3)) - Math.min(...g.slice(0, 3)) <= 6 && g[3] > 0.3, 'the Recently closed row\'s stripe is a solid grey of the text colour', grey);
    await look('sessions-closed', { expect: 'A RECENTLY CLOSED section with a clock icon at the top of the list, expanded, listing Nothing going on with "closed now" at the right and a solid grey stripe at its start, not blue, and less bright than the blue stripe of the conversation open in this window further down, if that is in view.' }, sidebarBox());
    await slTheme(THEMES.light);
    await look('sessions-closed-light', { expect: 'The same RECENTLY CLOSED section in a light theme: Nothing going on with a grey stripe that is plainly visible on the light background.' }, sidebarBox());
    await slTheme(THEMES.dark);
    await setting('agentPlus.sessions.recentlyClosed', 0);
    check(!!await until(() => sl.evaluate(() => { const s = document.querySelector('.sl-section[data-key="closed"]'); return !s || s.classList.contains('sl-hidden'); }), 8000, 300),
      'with agentPlus.sessions.recentlyClosed 0 the section goes');
    await setting('agentPlus.sessions.recentlyClosed', null);
    await exec('agentPlus.reopenClosedConversation');
    check(!!await frontIs(SLT.quiet), 'Reopen Closed Conversation opens it again in a tab');
  });

  await step('sessions-search', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    await exec('agentPlus.searchSessions');
    await until(() => sl.evaluate(() => document.activeElement && document.activeElement.tagName === 'INPUT'), 5000, 200);
    await page.keyboard.type('archive');
    const found = await slWait((r) => { const s = r.filter((x) => x.shown && x.section !== 'closed'); return s.length >= 1 && s.every((x) => /archive/i.test(x.title)); });
    check(!!found, 'Search keeps only the conversations whose title matches', found && found.filter((x) => x.shown).map((x) => x.title));
    await look('sessions-search', { expect: 'A search box under the chips holding "archive", and the list narrowed to the two conversations with "archive" in their title, the word highlighted in each: Review the archive sweep in Ungrouped, and Archived long ago in ARCHIVED.' }, sidebarBox());
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sl.locator('.sl-chip[data-chip="needs"]').click();
    const needsYou = await slWait((r) => { const s = r.filter((x) => x.shown && x.section !== 'closed').map((x) => x.title).sort(); return sameList(s, [SLT.askrun, SLT.ask, SLT.perm].sort()); });
    await sl.locator('.sl-chip[data-chip="running"]').click();
    const running = await slWait((r) => { const s = r.filter((x) => x.shown && x.section !== 'closed').map((x) => x.title); return s.length && s.every((t) => [SLT.run, SLT.bg, SLT.askrun, SLT.cc, SLT.ocTerm].includes(t)); });
    check(!!running, 'Running keeps the conversations running a turn or background work', running && running.filter((x) => x.shown).map((x) => x.title));
    const chipsDrawn = async () => {
      await slAway();
      const on = await pixelOf(sl.locator('.sl-chip.sl-on'), 4), off = await pixelOf(sl.locator('.sl-chip[data-chip="all"]'), 4);
      return { on, off, contrast: on && off ? contrast(on, off) : 0, grey: off ? Math.max(...off) - Math.min(...off) : 99 };
    };
    const CHIPS_LOOK = 'under the New bar, the chips All, Open, Running and Needs you with their counts. Running, the chosen chip, has the button colour and light text; the other three are a neutral grey with ordinary text.';
    let c = await chipsDrawn();
    check(c.contrast >= 1.5 && c.grey <= 12, 'dark: the chips not chosen are grey, and the chosen one stands out against them', c);
    await look('sessions-chips-dark', { expect: `The top of the list in a dark theme: ${CHIPS_LOOK}` }, sl.locator('.sl-top'));
    await slTheme(THEMES.light);
    c = await chipsDrawn();
    check(c.contrast >= 1.5 && c.grey <= 12, 'light: the chips not chosen are grey, and the chosen one stands out against them', c);
    await look('sessions-chips-light', { expect: `The top of the list in a light theme: ${CHIPS_LOOK}` }, sl.locator('.sl-top'));
    await slTheme(THEMES.dark);
    check(!!needsYou, 'Needs you keeps the three waiting on the user', (needsYou || await slRows()).filter((x) => x.shown).map((x) => [x.title, x.section, x.dot]));
    await sl.locator('.sl-chip[data-chip="all"]').click();
    await exec('agentPlus.filterSessions');
    const agents = await slMenu();
    check(!!agents && ['Codex', 'Claude Code', 'OpenCode'].every((x) => agents.includes(x)), 'Choose the Agents Shown lists the three agents', agents);
    await slItem('OpenCode').click();
    const noOc = await slWait((r) => !r.some((x) => x.shown && (x.title === SLT.oc || x.title === SLT.ocTerm)) && r.some((x) => x.shown && x.title === SLT.cc));
    check(!!noOc, 'and unticking one hides its conversations');
    await look('sessions-filter', { pointer: true, expect: 'A small menu at the top right of the list with Codex and Claude Code ticked and OpenCode unticked, each with its logo; no OpenCode row is in view.' }, sidebarBox());
    await slItem('OpenCode').click();
    await slClose();
    check(!!await slWait((r) => r.some((x) => x.shown && x.title === SLT.oc)), 'ticking it again shows them again');
    await viaUi('agentPlus.findConversation', () => start('agentPlus.findConversation'));
    await until(() => page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.quick-input-widget'))), 10000, 100);
    await page.keyboard.type('sl-ask');
    const found2 = await until(async () => { const r = await pickRows(); return r && r.length >= 1 && r.every((x) => /sl-ask/.test(x.text)) && r; }, 10000, 300);
    check(!!found2 && found2.some((x) => x.label === SLT.ask), 'Find Conversation matches part of the id and shows the agent beside each conversation', found2);
    await pick(SLT.ask);
    check(!!await frontIs(SLT.ask), 'and picking one opens it');
  });

  await step('sessions-account', async () => {
    needs('sessions-rows');
    await src('return src.configure(arg);', { account: { rows: [{ label: 'Signed in with', value: 'API key' }, { label: 'Tokens today', value: '1.9M' }],
      bars: [{ label: '5-hour limit', percent: 32, resetsAt: Date.now() + 2 * HOUR + 600e3 }, { label: 'Weekly limit', percent: 86, resetsAt: Date.now() + 3 * DAY }],
      links: [{ label: 'View details', command: 'agentPlusTest.installPlugin' }], conversation: { title: SLT.run, rows: [{ label: 'Tokens', value: '412k' }] } } });
    await showSessions('agentPlus.sessions');
    const folded = await until(() => sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]'); return !!a && !a.classList.contains('sl-hidden') && !a.classList.contains('sl-open'); }), 10000, 300);
    check(!!folded, 'Account & usage starts collapsed');
    await look('sessions-account-folded', { expect: 'An ACCOUNT & USAGE band at the top of the list, collapsed: its chevron points right, and the next section follows right under the band.' }, sidebarBox());
    await slOpen('Account & usage');
    const shown = await until(() => sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]'); return a && !a.classList.contains('sl-hidden') && a.classList.contains('sl-open') && /Signed in with/.test(a.innerText) && a.innerText; }), 10000, 300);
    check(!!shown && /Signed in with\s+API key/.test(shown) && /5-hour limit\s+32%\s+resets 2h 1\dm/.test(shown) && /This conversation\s+Fix the sessions page filter/i.test(shown),
      'Account & usage shows the agent\'s rows, its limits and when they reset, and the conversation in front', shown);
    await look('sessions-account-open', { expect: 'An ACCOUNT & USAGE section at the top of the list, expanded: a Codex block with its logo and a View details link at the right, Signed in with API key, Tokens today 1.9M, and two bars laid out alike: 5-hour limit 32% with a short blue fill and Weekly limit 86% with a long orange fill, each with the percentage on the label\'s line and when it resets under the bar. After the bars, with no line above it, a small heading THIS CONVERSATION in capitals; under it, Fix the sessions page filter in ordinary letters, then that conversation\'s Tokens 412k; the account\'s figures above it must not look like the conversation\'s.' }, sidebarBox());
    await src('return src.configureOther(arg[0], arg[1]);', ['claude-code', { account: { rows: [{ label: 'Plan', value: 'Max' }], conversation: { title: SLT.cc, rows: [{ label: 'Context', value: '38%' }] } } }]);
    await src('return src.configureOther(arg[0], arg[1]);', ['opencode', { account: { rows: [{ label: 'Provider', value: 'Bedrock' }] } }]);
    const blocks = await until(() => sl.evaluate(() => {
      const b = [...document.querySelectorAll('.sl-section[data-key="account"] .sl-acct')];
      if (b.length < 3) return null;
      const st = (e) => getComputedStyle(e);
      return { names: b.map((x) => x.querySelector('.sl-acct-name').textContent), lines: b.map((x) => `${st(x).borderTopStyle} ${st(x).borderTopWidth}`),
        subs: [...document.querySelectorAll('.sl-section[data-key="account"] .sl-acct-sub')].map((x) => st(x).borderTopStyle) };
    }), 10000, 300);
    check(!!blocks && sameList(blocks.names, ['Codex', 'Claude Code', 'OpenCode']) && blocks.lines[0].startsWith('none') && blocks.lines.slice(1).every((l) => l === 'solid 1px')
      && blocks.subs.length === 2 && blocks.subs.every((x) => x === 'none'),
    'each agent has a block of its own, with a line between two blocks, none above the first, and none above a block\'s THIS CONVERSATION heading', blocks);
    /* Scrolls to the end of the section: the three blocks are taller than the view. */
    const toEnd = () => sl.evaluate(() => { const b = [...document.querySelectorAll('.sl-section[data-key="account"] .sl-acct')].pop(); if (b) b.scrollIntoView({ block: 'end' }); });
    const LINES_LOOK = 'the end of the Codex block (THIS CONVERSATION, with no line above that heading, Fix the sessions page filter and Tokens 412k), then a thin line across, a Claude Code block with its logo, Plan Max and its own THIS CONVERSATION heading, also with no line above it, with A Claude Code conversation and Context 38%, then another thin line, and an OpenCode block with its logo and Provider Bedrock. The top of the section may be scrolled out of view.';
    await toEnd();
    await look('sessions-account-lines', { expect: `The ACCOUNT & USAGE section in a dark theme, scrolled to its end: ${LINES_LOOK}` }, sidebarBox());
    await slTheme(THEMES.light);
    await toEnd();
    await look('sessions-account-lines-light', { expect: `The same in a light theme, dark text on a light background with grey lines: ${LINES_LOOK}` }, sidebarBox());
    await slTheme(THEMES.dark);
    await sl.evaluate(() => { const r = document.querySelector('.sl-root'); if (r) r.scrollTop = 0; });
    await src('return src.configureOther(arg[0], arg[1]);', ['claude-code', { account: null }]);
    await src('return src.configureOther(arg[0], arg[1]);', ['opencode', { account: null }]);
    await sl.locator('.sl-acct .sl-link').filter({ hasText: 'View details' }).click();
    check(!!await until(async () => (await src('return src.state.ran;')).includes('installPlugin'), 5000, 200), 'a link runs the command the agent gave');
    await slHead('Account & usage').click();
    await look('sessions-account-closed', { expect: 'The ACCOUNT & USAGE header collapsed to one band with its chevron pointing right, and the sections below it moved up.' }, sidebarBox());
    await slHead('Account & usage').click();
    /* An agent not signed in gives a part with one line and no bars, which the list draws like any other part. */
    await src('return src.configure(arg);', { account: { rows: [{ label: 'Account', value: 'Not signed in' }] } });
    const plain = await until(() => sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]');
      return !!a && !a.classList.contains('sl-hidden') && /Account\s+Not signed in/.test(a.innerText) && !a.querySelector('.sl-bar') && a.innerText; }), 10000, 300);
    check(!!plain, 'an agent not signed in gives a part with one line and no bars, and it is drawn under the agent\'s name with nothing else', plain);
    await look('sessions-account-not-signed-in', { expect: 'An ACCOUNT & USAGE section at the top of the list, expanded, with one Codex block: its logo and the name Codex, and under it a single line, Account at the left and Not signed in at the right. No bars, no links and no conversation lines.' }, sidebarBox());
    await src('return src.configure(arg);', { account: null });
    const left = await until(() => sl.evaluate(() => { const a = document.querySelector('.sl-section[data-key="account"]'); return !!a && a.classList.contains('sl-hidden'); }), 10000, 300);
    check(!!left, 'with no agent giving a part, the section is left out');
  });

  await step('sessions-new', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    const first = await until(() => sl.evaluate(() => document.querySelector('.sl-new-agent').title), 5000, 200);
    check(/starts? in Claude Code\b/.test(first || ''), 'the New bar starts with Claude Code, the first of Claude Code, Codex and OpenCode in the order it picks from, though Codex registered earlier', first);
    const half = sl.locator('.sl-new-half.sl-primary');
    const hovered = async () => {
      await slAway();
      const off = await pixelOf(half, 3, 3);
      await half.hover({ position: { x: 3, y: 3 } });
      await sleep(300);
      const on = await pixelOf(half, 3, 3);
      return { off, on, contrast: off && on ? contrast(off, on) : 0 };
    };
    let h = await hovered();
    check(h.contrast >= 1.25, 'dark: New in tab plainly changes colour under the pointer', h);
    await look('sessions-new-hover-dark', { pointer: true, expect: 'The New bar in a dark theme with the pointer on New in tab: its blue is plainly darker than the button blue VS Code draws elsewhere, such as the chosen chip All under it; the white text on it is still easy to read.' },
      sl.locator('.sl-top'));
    /* The theme's button colour and button hover colour both set to one purple, not the default blue, so that the
       picture shows the customization took effect. */
    const hex = '#7b3fbf';
    await setting('workbench.colorCustomizations', { 'button.background': hex, 'button.hoverBackground': hex });
    await sleep(1000);
    h = await hovered();
    check(h.contrast >= 1.25, 'and also in a theme whose button hover colour is the button colour itself', Object.assign({ hoverBackground: hex }, h));
    await look('sessions-new-hover-same', { pointer: true, expect: 'The New bar in a dark theme with purple buttons that keep the same purple under the pointer. The chosen chip All, under the bar, is that purple; New in tab, with the pointer on it, is plainly a darker purple, its text white and readable.' },
      sl.locator('.sl-top'));
    await setting('workbench.colorCustomizations', null);
    await slTheme(THEMES.light);
    h = await hovered();
    check(h.contrast >= 1.25, 'light: New in tab plainly changes colour under the pointer', h);
    await look('sessions-new-hover-light', { pointer: true, expect: 'The same in a light theme: New in tab, under the pointer, is a darker blue than the chip All below it, and its white text is still readable.' },
      sl.locator('.sl-top'));
    await slTheme(THEMES.dark);
    await page.mouse.move(5, 5);
    await sl.locator('.sl-new-agent').click();
    const m = await slMenu();
    check(!!m && sameList(m, ['Codex', 'Claude Code', 'OpenCode']), 'the New bar\'s logo opens a list of the agents', m);
    await look('sessions-new-menu', { pointer: true, expect: 'Under the New bar\'s logo, a small menu listing Codex, Claude Code and OpenCode, each with its logo, with a tick in a column before Claude Code\'s logo only, as the agents filter marks its choices.' }, sidebarBox());
    await slItem('Claude Code').click();
    await until(() => sl.evaluate(() => /Claude Code/.test(document.querySelector('.sl-new-agent').title)), 5000, 200);
    await sl.locator('.sl-new-half[data-where="sidebar"]').click();
    check(!!await until(async () => (await calls('claude-code')).some((c) => c[0] === 'create' && c[2].where === 'sidebar'), 8000, 300),
      'picking Claude Code, then New in sidebar, starts a Claude Code conversation in the sidebar');
    await sl.locator('.sl-new-agent').click();
    await slItem('Codex').click();
    await until(() => sl.evaluate(() => /Codex/.test(document.querySelector('.sl-new-agent').title)), 5000, 200);
    await sl.locator('.sl-new-half[data-where="tab"]').click();
    check(!!await frontIs('New conversation 1'), 'and Codex, then New in tab, a Codex conversation in a tab');
    check(!!await until(() => sl.evaluate(() => /Claude Code/.test(document.querySelector('.sl-new-agent').title)), 8000, 200),
      'once that conversation has started, the New bar starts with Claude Code again', await sl.evaluate(() => document.querySelector('.sl-new-agent').title));
  });

  await step('sessions-rules', async () => {
    needs('sessions-rows');
    await showSessions('agentPlus.sessions');
    await setting('agentPlus.sessions.hideBackground', false);
    const kid = await slWait((r) => { const u = r.filter((x) => x.section === 'ungrouped'); const i = u.findIndex((x) => x.title === SLT.kid); return i > 0 && u[i - 1].title === SLT.run && parseInt(u[i].indent, 10) > 8; });
    check(!!kid, 'with agentPlus.sessions.hideBackground off, a sub-agent is shown, indented under the conversation that started it', kid && kid.filter((x) => x.section === 'ungrouped').map((x) => [x.title, x.indent]));
    await look('sessions-background', { expect: 'A sub-agent listed straight under Fix the sessions page filter, indented further than the other rows.' }, sidebarBox());
    await setting('agentPlus.sessions.hideBackground', null);
    await setting('agentPlus.sessions.archiveAfterDays', 25);
    const archived = await slWait((r) => slFind(r, SLT.month, 'archived') && slFind(r, SLT.weeks, 'ungrouped'), 15000);
    check(!!archived && !!slFind(archived, SLT.ocOld, 'archived'), 'with agentPlus.sessions.archiveAfterDays 25, a conversation inactive for a month is archived at once but one inactive for three weeks is not; '
      + 'one archived 60 days ago is not deleted at 90 days', archived && archived.filter((x) => [SLT.month, SLT.weeks, SLT.ocOld].includes(x.title)).map((x) => [x.title, x.section]));
    await setting('agentPlus.sessions.deleteArchived', false);
    await setting('agentPlus.sessions.deleteAfterDays', 30);
    await sleep(3000);
    check(!(await calls('opencode')).some((c) => c[0] === 'delete'), 'with agentPlus.sessions.deleteArchived off nothing is deleted, even at 30 days');
    await setting('agentPlus.sessions.deleteArchived', null);
    const deleted = await until(async () => (await calls('opencode')).some((c) => c[0] === 'delete' && sameList(c[1], ['oc-old'])), 15000, 300);
    check(!!deleted && !!await slWait((r) => !slFind(r, SLT.ocOld)), 'and with it on again, one archived for 60 days is deleted at agentPlus.sessions.deleteAfterDays 30');
    for (const k of ['archiveAfterDays', 'deleteAfterDays']) await setting(`agentPlus.sessions.${k}`, null);
  });

  await step('sessions-empty', async () => {
    needs('sessions-rows');
    await src('return src.removeOther() && src.removeThird();');
    await conversations([]);
    await src('return src.configure(arg);', { sessionsNotice: { text: 'Codex was not found on this machine.', actions: [{ label: 'Install Codex', command: 'agentPlusTest.installPlugin' }] } });
    await showSessions('agentPlus.sessions');
    const empty = await until(() => sl.evaluate(() => { const e = [...document.querySelectorAll('.sl-empty')].find((x) => !x.classList.contains('sl-hidden')); const n = document.querySelector('.sl-notice'); return e && n && { empty: e.textContent, note: n.innerText }; }), 10000, 300);
    check(!!empty && empty.empty === 'No conversations yet' && /Codex was not found on this machine\./.test(empty.note) && /Install Codex/.test(empty.note),
      'with no conversation the list says so, and an agent\'s note is shown above it with its button', empty);
    await look('sessions-empty', { expect: 'The list with no conversations: the New bar, the chips all at 0, a note with the Codex logo saying "Codex was not found on this machine." with an Install Codex button, and No conversations yet below.' }, sidebarBox());
    await src('return src.configure(arg);', { sessionsNotice: null, ran: [] });
    await sl.locator('.sl-note-btn').filter({ hasText: 'Install Codex' }).click().catch(() => {});
    await src('return src.configure(arg);', { sessionsNotice: null });
  });

  await step('show-status', async () => {
    await exec('agentPlus.showStatus');
    const said = await until(() => {
      const f = walk(path.join(profile.user, 'logs')).filter((x) => /Agent Plus\.log$/.test(x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const text = f ? fs.readFileSync(f, 'utf8') : '';
      return /Agent Plus \d+\.\d+\.\d+: protocol 1, accepts 1/.test(text) && /Source codex: Codex, from xnervwang\.codex-plus/.test(text) && text;
    }, 10000, 300);
    check(!!said && /Workspace trusted: yes/.test(said) && /Extensions using it: xnervwang\.codex-plus 0\.0\.1 \(protocol 1\)/.test(said)
      && /Token mode: All features \(agentPlus\.tokenMode\)/.test(said) && said.includes(`plans in ${profile.plans}`),
    'Show Status writes the version, trust, the extensions using it, the token mode and each agent with its plans folder to the Agent Plus output', said && said.split('\n').filter((l) => /^(Agent Plus|Workspace|Extensions|Token|Source|In front|Answers)/.test(l)));
    const shown = await until(() => page.evaluate(() => { const o = document.querySelector('.part.panel .output-view, .part.panel [id="workbench.panel.output"]'); return !!o && !!o.offsetParent; }), 10000, 300);
    check(!!shown, 'and opens the Output panel');
    await look('show-status', { expect: 'The Output panel at the bottom with Agent Plus chosen, its last lines naming the Agent Plus version and protocol, Workspace trusted: yes, the extension using it, the token mode, the answers folder, the conversation in front and the source codex with its plans folder.' },
      page.locator('#workbench\\.parts\\.panel'));
  });
  await shut();

  /* ═══ restricted: the helper and the stand-in source in Restricted Mode ═══ */
  writeSettings({ 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' });
  QPLANS();
  await open('restricted', [SOURCE], { trust: true });
  await step('restricted', async () => {
    check(await call('return vscode.workspace.isTrusted;') === false, 'the window opens the folder in Restricted Mode');
    /* VS Code asks for trust when something of its own needs it, such as a terminal it puts back in the panel; that is
       not this extension's, and the folder stays untrusted. */
    const trust = page.locator('.monaco-dialog-box').filter({ hasText: 'Do you trust the authors' }).first();
    if (await trust.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
      note(`VS Code asked to trust the folder on its own (${((await dialog()) || {}).text || ''}); cancelled`.replace(/\s+/g, ' '));
      await trust.locator('.dialog-buttons .monaco-button').filter({ hasText: /^Cancel$/ }).first().click();
    }
    const r = await src('return src.result;');
    check(!!r && r.accepted, 'the stand-in source registers there too', r);
    await conversations(QCONVS());
    await showConversations();
    const listed = await until(async () => !!await convRow(`1. ${Q1}`), 20000, 300);
    check(!!listed, 'the Conversations view still lists the conversations and their questions', await convRows());
    if (!listed) return;
    await clickRow('agentPlus.conversations', `1. ${Q1}`);
    const f = await answerFrame({ title: 'Asked about the release branch' });
    const s = f && await answerSays(f);
    check(!!s && s.status === 'Restricted Mode: this window does not send answers. Trust the workspace to send one.' && !s.box && !s.send
      && s.placeholder === '', 'the Answer view shows the question, says Restricted Mode sends no answer, and has its box and Send disabled, '
      + 'with no placeholder saying Ctrl+Enter sends', s);
    const mine = (() => { try { return fs.readdirSync(path.join(profile.shared, 'attention')).filter((n) => fs.statSync(path.join(profile.shared, 'attention', n)).mtimeMs > launchedAt); } catch (_) { return []; } })();
    check(!mine.length, 'and the window writes nothing to the folder the windows share', mine);
    await showSessions('agentPlus.sessions');
    const note = await until(() => sl.evaluate(() => { const n = document.querySelector('.sl-notice'); return n && n.innerText; }), 10000, 300);
    check(!!note && /Restricted Mode/.test(note) && /Manage Workspace Trust/.test(note) && !!await slWait((r) => r.some((x) => x.title === 'Asked about the release branch')),
      'the session list still shows the conversations, says it changes nothing in Restricted Mode, and offers Manage Workspace Trust', note);
    check(await sl.evaluate(() => document.querySelector('.sl-new').classList.contains('sl-hidden')), 'and has no New bar');
    const wrote = (() => { try { const d = path.join(profile.shared, 'session-list'); return fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).mtimeMs > launchedAt); } catch (_) { return []; } })();
    check(!wrote.length, 'and writes none of its own data to the folder the windows share', wrote);
    await look('sessions-restricted', { expect: 'The Conversations side bar in Restricted Mode: no New bar, a note saying Restricted Mode: the list shows conversations and changes nothing, with a Manage Workspace Trust button, and the conversations listed below.' }, sidebarBox());
    await look('restricted', { expect: 'The window in Restricted Mode (a Restricted Mode badge at the left of the status bar). The Conversations view lists Asked about the release branch with its question; the Answer view shows that question with a greyed-out box and Send, and says Restricted Mode: this window does not send answers. Trust the workspace to send one.' },
      page.locator('#workbench\\.parts\\.panel'));
  });
  await shut();
}

module.exports = { run, LOOK_SETTINGS };
