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
 * AGENT_PLUS_UI_STEPS, a regular expression, runs only the steps whose names match; a step that needs an earlier one
 * fails, naming it, when that step did not run to its end.
 */
const fs = require('fs');
const path = require('path');
const win = require('./lib/window');
const pixels = require('./lib/pixels');

const { sleep, until } = win;
const SOURCE = path.join(__dirname, 'source');
const FEATURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-features.json'), 'utf8'));
const LOOK_SETTINGS = {};
const SCALE = 2;
/* src/envelope.js: 📩 in dark themes, the plain envelope's text form in light ones. */
const COLOUR = '\u{1F4E9}', TEXT = '\u2709\uFE0E';
const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', hcLight: 'Default High Contrast Light' };
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

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function run({ exe, profile, env, playwright, out, check, note, look: looking }) {
  const shotsDir = path.join(out, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  const linux = process.platform === 'linux';
  let w = null, page = null, call = null, launchedAt = 0;
  const only = process.env.AGENT_PLUS_UI_STEPS ? new RegExp(process.env.AGENT_PLUS_UI_STEPS) : null;
  const done = new Set();
  let current = '';
  const step = async (name, fn) => {
    if (only && !only.test(name)) { note(`${name}: not run, as AGENT_PLUS_UI_STEPS leaves it out`); return; }
    console.log(`\n── ${name}`);
    current = name;
    try { await fn(); done.add(name); } catch (e) {
      check(false, `${name}: ran to its end`, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
      await page.screenshot({ path: path.join(shotsDir, `error-${name}.png`) }).catch(() => {});
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
    const pane = [...document.querySelectorAll('.pane')].find((p) => { const x = p.querySelector(':scope > .pane-header'); return x && (x.getAttribute('aria-label') || '').startsWith(h); });
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
  const pane = (view) => page.locator(`.pane:has(> .pane-header[aria-label^="${HEADERS[view]}"])`).first();
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
  const clickRow = async (view, title, opts) => {
    if (view === 'agentPlus.conversations') await showConversations();
    await clearToasts();
    return rowLoc(view, title).click(opts);
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
    const p = [...document.querySelectorAll('.pane')].find((x) => { const y = x.querySelector(':scope > .pane-header'); return y && (y.getAttribute('aria-label') || '').startsWith(h); });
    const m = p && p.querySelector('.welcome-view-content');
    return m && m.offsetParent ? m.innerText.trim() : '';
  }, HEADERS[view]);

  const entry = (name) => page.evaluate((id) => {
    const e = document.getElementById(`xnervwang.agent-plus.agentPlus.${id}`);
    return e && e.offsetParent ? { text: e.innerText.trim(), label: e.getAttribute('aria-label') || '', warning: e.classList.contains('warning-kind'),
      error: e.classList.contains('error-kind') } : null;
  }, name);
  const entryLoc = (name) => page.locator(`[id="xnervwang.agent-plus.agentPlus.${name}"]`);
  /* How many conversations the Conversations entry in the status bar says need the user; 0 when it says none. */
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
  const LOOK_OF = { working: ['codicon-circle-filled', 'charts.green'], background: ['codicon-circle', 'charts.green'], waiting: ['codicon-circle-filled', 'charts.red'],
    stopped: ['codicon-blank', ''] };
  const WORDS = { working: 'Running a turn', background: 'Turn over, only background work running', waiting: 'Waiting for you', stopped: 'Stopped' };
  /* Checks the icon, colour and envelope of each row of DOTS; `glyph` is the envelope the theme should draw. */
  const dotsWrong = async (glyph) => {
    const rows = await convRows() || [];
    const colors = { 'charts.green': await themeColor('charts.green'), 'charts.red': await themeColor('charts.red') };
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

  await step('conversation-dots', async () => {
    await openNotes();
    await conversations(DOTS.map(([id, title, state, activity, unseen]) => conv(id, title, state, activity, unseen)));
    await showConversations();
    const listed = await until(async () => { const r = await convRows(); return r && DOTS.every(([, t]) => r.some((x) => x.title === t)) && r; }, 20000, 300);
    check(!!listed, `the Conversations view lists the ${DOTS.length} conversations of the stand-in source`, await convRows());
    const wrong = await until(async () => { const x = await dotsWrong(COLOUR); return x.length ? null : x; }, 10000, 500) || await dotsWrong(COLOUR);
    check(!wrong.length, 'each row\'s icon says its activity: a green dot running a turn, a green ring with only background work left, a red dot waiting for the user, none stopped; and the dark theme\'s envelope ends each row with a reply not read, and no other', wrong);
    const run = await convRow('Running a turn');
    check(!!run && /working · no work plan/.test(run.description), 'a row\'s description says its state and that it keeps no work plan', run && run.description);
    await look('conversation-dots', { expect: 'The Conversations view in the panel lists eight conversations. Running a turn and Running, with a reply not read yet have a filled green dot; Only background work left and Background work, reply not read have a hollow green ring; At a permission prompt has a filled red dot; Stopped with a reply not read, Stopped, nothing new and the row with the long title have no dot, their titles lined up with the others. An envelope ends the rows Running, with a reply not read yet; Background work, reply not read; Stopped with a reply not read; and the long one, and no other row. No blue dot anywhere.' },
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
    check(!!st && /2 conversations need you/.test(st.text) && st.warning && !st.error,
      'and the status bar entry says 2 conversations need you, on a yellow background', st);
    await look('question-rows', { expect: 'Asked about the release branch has a red dot, needs you · 1 question beside it, and under it the question Release from main or from the hotfix branch? with an orange question mark and asked 1m ago, then the doing row 2. Rewrite the parser. Asked days ago has a green dot, not red, with its own question under it. The Conversations tab shows a badge of 2, and the status bar has 2 conversations need you on a red background.' },
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
    check(!!st && /2 conversations need you/.test(st.text), 'the status bar entry says 2 conversations need you', st);
    const tip = await hoverText(entryLoc('conversations'));
    check(tip.startsWith('2 conversations need you:') && tip.includes('Asked about the release branch · 1 question') && tip.includes('Asked days ago · 1 question'),
      'hovering it lists those conversations, each with how many questions it has', tip);
    await look('status-hover', { pointer: true, toasts: true, expect: 'A hover box above the status bar entry 2 conversations need you, reading 2 conversations need you:, then Asked about the release branch · 1 question and Asked days ago · 1 question on lines of their own.' },
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
    const badge = await page.evaluate(() => {
      const a = [...document.querySelectorAll('.activitybar .action-item')].find((x) => { const l = x.querySelector('.action-label'); return !!l && /^Agent Plus/.test(l.getAttribute('aria-label') || ''); });
      const b = a && a.querySelector('.badge-content');
      return b ? b.innerText.trim() : '';
    });
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
    check(!!firstRow, 'the Conversations view lists the conversation in front first', await convRows());
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
      'a click on a row that asks nothing opens a dialog with its title, state and description', d);
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
      'the pen on a row asks the conversation\'s agent to put About row 2 (Rewrite the parser): in its message box', got);
    await src('src.configure({ prefillOutcome: { outcome: "notReceived", reason: "no message box here" } }); return true;');
    await clearToasts();
    await row.hover();
    await pen.click({ timeout: 10000 });
    const t = await toastWith('could not put it in the conversation', 10000);
    const clip = await call('return vscode.env.clipboard.readText();');
    check(!!t && /no message box here/.test(t.text) && clip === 'About row 2 (Rewrite the parser): ',
      'when the agent could not, the text is on the clipboard and a notification says why', { toast: t, clip });
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
    await look('several-agents', { expect: 'The Conversations view lists seven conversations, each with a small logo instead of a plain dot: a blue square with a white plus for the five Codex ones, an orange circle with a white star for the two Claude Code ones. The logos of running conversations carry a green dot at the top right (a hollow green ring on Only background work left), At a permission prompt carries a red one, and Claude Code, stopped has the logo alone.' },
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
    check(!!tip && tip.label.includes('Waiting for you to approve something or answer') && tip.label.includes(NWAIT) && tip.warning,
      'whose hover lists it among those waiting for you to approve something or answer, on a yellow background', tip);
    if (!canFocus) {
      check(await noToast(NWAIT, 6000), `with no window focused (this ${process.platform} runner gave the window none), no notification is shown`);
      return;
    }
    const t = await toastWith(`"${NWAIT}" is waiting for you.`, 10000);
    check(!!t && sameList(t.buttons, ['Open', 'Dismiss']), 'the focused window shows a notification that it is waiting for you, with Open and Dismiss', t || await toasts());
    await look('notify-waiting', { toasts: true, expect: 'A notification at the bottom right: "Waits for permission" is waiting for you., with the buttons Open and Dismiss. In the status bar, on a yellow background, N conversations need you.' },
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
    check((await bell()) === before, 'and the status bar does not count it: a reply not read is left to its notification', { before, now: await bell() });
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
    check((await bell()) === before, 'and the status bar count, which never had it, stays as it was', { before, now: await bell() });
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
    check((await bell()) === before, 'and once another tab is in front it is still not counted, as a reply not read is left to its notification', { before, now: await bell() });
    check(await noToast(NFRONT, 4000), 'but not announced after the fact');
    await look('attention-count', { expect: 'The status bar at the bottom right has N conversations need you on a yellow background, counting the conversations that wait for you; there is no separate bell entry of Agent Plus, and no notification is on screen.' },
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
    check((await bell()) === 1, 'and, a reply not read being left to its notification, the status bar does not count it', await bell());
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
    const gone = await until(async () => !await page.evaluate(() => [...document.querySelectorAll('.activitybar .action-item .action-label')].some((a) => /^Agent Plus/.test(a.getAttribute('aria-label') || ''))), 10000, 300);
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
    await look('view-settings-off', { expect: 'No Conversations tab in the panel; the status bar has 1 conversation needs you on a yellow background and the token mode entry All.' },
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
    await look('restricted', { expect: 'The window in Restricted Mode (a Restricted Mode badge at the left of the status bar). The Conversations view lists Asked about the release branch with its question; the Answer view shows that question with a greyed-out box and Send, and says Restricted Mode: this window does not send answers. Trust the workspace to send one.' },
      page.locator('#workbench\\.parts\\.panel'));
  });
  await shut();
}

module.exports = { run, LOOK_SETTINGS };
