// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

/*
 * Page script for the session list (src/session-list-view.js). The host posts { type: 'model' } whenever the list
 * changes, with the model src/session-list.js builds and each agent's logo as data URIs. From the page script of Codex
 * Plus's session list (its src/page/sessions-page.js): rows and sections are kept per key and reused, and a field is
 * written only when its value differs, so a one-row change rewrites one row.
 *
 * A row has the stripe at its start (open here, open somewhere else, closed here lately), the agent's logo with the
 * status dot at its top right, the title, its marks, and the time, which the row's buttons take the place of while it
 * is hovered.
 *
 * Collapsed sections, the filter, the agents hidden and the search are saved with setState, so they survive VS Code
 * dropping the page while the view is hidden. Account & usage, Recently closed and Archived start collapsed.
 *
 * While the pointer is on the sections, a menu of the list is open, or the arrow keys are on a row, the rows of each
 * section keep the order they are drawn in, so that a row does not move away from under a click; the model's order is
 * drawn once none of these holds. A row new to a section still appears where the model puts it, and pinned rows still
 * come first.
 */
(function () {
  'use strict';
  const host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() { return null; }, setState() {} };
  const root = document.getElementById('root');
  if (!root) return;
  const send = (msg) => { try { host.postMessage(msg); } catch (_) { /* the host is gone */ } };

  const saved = host.getState() || {};
  const ui = {
    collapsed: Object.assign({ account: true, closed: true, archived: true }, saved.collapsed || {}),
    filter: ['all', 'open', 'running', 'needs'].includes(saved.filter) ? saved.filter : 'all',
    hidden: Object.assign({}, saved.hidden || {}),
    search: typeof saved.search === 'string' ? saved.search : '',
    searchOpen: typeof saved.search === 'string' && saved.search !== '',
  };
  const keep = () => { try { host.setState({ collapsed: ui.collapsed, filter: ui.filter, hidden: ui.hidden, search: ui.search }); } catch (_) { /* not kept */ } };

  /* ── building blocks ── */
  const SVG = 'http://www.w3.org/2000/svg';
  /* Line drawings on a 16 px grid, in the manner of VS Code's own icons. */
  const ICONS = {
    chevron: ['M6 4l4 4-4 4'],
    plus: ['M8 3v10', 'M3 8h10'],
    caret: ['M5 6.5l3 3 3-3'],
    search: ['M7 3a4 4 0 1 1 0 8a4 4 0 0 1 0-8z', 'M10 10l3.5 3.5'],
    close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
    check: ['M3.5 8.5l3 3 6-7'],
    pin: ['M9.5 2.5l4 4', 'M10.5 3.5L7 7H4.5L9 11.5V9l3.5-3.5', 'M6.5 9.5L3 13'],
    unpin: ['M9.5 2.5l4 4', 'M10.5 3.5L7 7H4.5L9 11.5V9l3.5-3.5', 'M6.5 9.5L3 13', 'M2.5 2.5l11 11'],
    pencil: ['M10.5 2.5l3 3-7.5 7.5H3v-3z'],
    archive: ['M2.5 3.5h11v3h-11z', 'M3.5 6.5v6h9v-6', 'M6.5 9h3'],
    restore: ['M6 3.5l-3 3 3 3', 'M3 6.5h7a3 3 0 0 1 0 6H8'],
    history: ['M3 8a5 5 0 1 0 1.5-3.5', 'M3 2.5V5h2.5', 'M8 5.5V8l2 1.5'],
    folder: ['M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'],
    account: ['M8 2.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5z', 'M3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4'],
    filter: ['M2.5 3h11L9.5 8v4.5l-3 1V8z'],
    mail: ['M2.5 4h11v8h-11z', 'M2.5 4.5L8 9l5.5-4.5'],
    crown: ['M3 12.5h10', 'M3.2 11L2.5 5l3.2 2.6L8 3.5l2.3 4.1L13.5 5l-.7 6z'],
    window: ['M5.5 2.5h8v6h-8z', 'M2.5 6.5h8v7h-8z', 'M2.5 9h8'],
    terminal: ['M2.5 3.5h11v9h-11z', 'M5 6.5l2 1.5-2 1.5', 'M8.5 10h3'],
    tab: ['M2.5 12.5v-8h4l1 1.5h6v6.5z'],
    side: ['M2.5 3.5h11v9h-11z', 'M6.5 3.5v9'],
  };
  const icon = (name, cls = 'sl-icon') => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const button = (cls, title, ...kids) => { const b = el('button', cls); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); } b.append(...kids); return b; };
  const setText = (e, text) => { if (e.textContent !== text) e.textContent = text; };
  const themeColor = (id) => (id ? `var(--vscode-${String(id).replace(/\./g, '-')})` : '');
  const light = () => /\bvscode-(light|high-contrast-light)\b/.test(document.body.className);
  const logoOf = (sourceId) => { const l = model && model.logos && model.logos[sourceId]; return l ? (light() ? l.light : l.dark) || '' : ''; };
  const labelOf = (sourceId) => { const s = model && (model.sources || []).find((x) => x.id === sourceId); return s ? s.label : sourceId; };
  const setLogo = (img, sourceId) => { const src = logoOf(sourceId); if (img.getAttribute('src') !== src) { if (src) img.setAttribute('src', src); else img.removeAttribute('src'); } img.alt = labelOf(sourceId); };

  /* ── the parts above the sections ── */
  const top = el('div', 'sl-top');
  const newBar = el('div', 'sl-new');
  const newAgent = button('sl-new-agent', 'Choose the agent of a new conversation');
  const newLogo = el('img', 'sl-logo-img');
  newAgent.append(newLogo, icon('caret'));
  newAgent.dataset.tool = 'agent';
  const newTab = button('sl-new-half', 'Start a conversation in a new editor tab', icon('plus'), el('span', '', 'New in tab'), icon('tab', 'sl-icon sl-place'));
  newTab.dataset.where = 'tab';
  const newSide = button('sl-new-half', 'Start a conversation in the sidebar', icon('plus'), el('span', '', 'New in sidebar'), icon('side', 'sl-icon sl-place'));
  newSide.dataset.where = 'sidebar';
  /* While pressed, the next conversation either half starts is temporary; then it lets go. */
  const newTemp = button('sl-new-temp', 'Make the next new conversation temporary', el('span', 'sl-temp-glyph', '\u23f3'));
  newTemp.dataset.tool = 'temp';
  newTemp.setAttribute('aria-pressed', 'false');
  let tempOn = false;
  const setTempOn = (on) => { tempOn = !!on && !newTemp.disabled; newTemp.classList.toggle('sl-on', tempOn); newTemp.setAttribute('aria-pressed', String(tempOn)); };
  newBar.append(newAgent, newTab, newSide, newTemp);
  /* A bar too narrow for both labels keeps the default half's label and shows the other half as an icon, rather than
     as a label cut down to a letter or two. */
  function fitNew() {
    newBar.classList.remove('sl-tight');
    const other = [newTab, newSide].find((b) => !b.classList.contains('sl-primary'));
    const label = other && other.querySelector('span');
    if (label && label.scrollWidth > label.clientWidth + 1) newBar.classList.add('sl-tight');
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fitNew()).observe(newBar);
  /*
   * The colour under the pointer of the New bar's default half, the one drawn in the button colour. Where the theme's
   * button hover colour is hard to tell from the button's own, as in VS Code's default themes or a theme that gives
   * both the same, it is the button's colour mixed 18% with black, or with white under dark text, so that the text
   * stays as readable.
   */
  const HOVER_MIN_RATIO = 1.3;
  function fitHover() {
    const css = getComputedStyle(document.documentElement);
    const probe = el('span');
    probe.style.display = 'none';
    root.appendChild(probe);
    const rgb = (name) => {
      if (!css.getPropertyValue(name).trim()) return null;
      probe.style.color = `var(${name})`;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
      return m ? m.slice(1, 4).map(Number) : null;
    };
    const bg = rgb('--vscode-button-background'), over = rgb('--vscode-button-hoverBackground'), fg = rgb('--vscode-button-foreground');
    probe.remove();
    const lum = (c) => c.map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    if (bg && (!over || ratio(bg, over) < HOVER_MIN_RATIO)) {
      root.style.setProperty('--sl-primary-hover', `color-mix(in srgb, var(--vscode-button-background) 82%, ${fg && lum(fg) < 0.4 ? '#ffffff' : '#000000'})`);
    } else root.style.removeProperty('--sl-primary-hover');
  }
  fitHover();
  new MutationObserver(fitHover).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  const chips = el('div', 'sl-chips');
  const CHIPS = [['all', 'All'], ['open', 'Open'], ['running', 'Running'], ['needs', 'Needs you']];
  const chipEls = new Map(CHIPS.map(([k, label]) => {
    const b = button('sl-chip', '', el('span', '', label), el('span', 'sl-chip-n', '0'));
    b.dataset.chip = k;
    chips.appendChild(b);
    return [k, b];
  }));
  const searchBox = el('div', 'sl-search sl-hidden');
  const searchInput = el('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search conversations…';
  searchInput.setAttribute('aria-label', 'Search conversations');
  searchInput.spellcheck = false;
  const clearBtn = button('sl-clear', 'Clear search', icon('close'));
  clearBtn.dataset.tool = 'clear';
  searchBox.append(icon('search'), searchInput, clearBtn);
  const notes = el('div', 'sl-notes');
  top.append(newBar, chips, searchBox, notes);
  const body = el('div', 'sl-body');
  const nullText = el('div', 'sl-empty sl-hidden', 'No conversations yet');
  const noneText = el('div', 'sl-empty sl-hidden', 'No conversations match');
  const hoverBox = el('div', 'sl-hover sl-hidden');
  root.append(top, body, nullText, noneText, hoverBox);

  /* ── sections ── */
  const SECTION_ICON = { account: 'account', closed: 'history', group: 'folder' };
  function makeSection(key, kind) {
    const s = el('div', 'sl-section');
    s.dataset.key = key;
    const head = el('div', 'sl-head');
    head.dataset.toggle = key;
    head.tabIndex = -1;
    const name = el('span', 'sl-head-label');
    const count = el('span', 'sl-head-count');
    head.append(icon('chevron', 'sl-icon sl-chevron'));
    if (SECTION_ICON[kind]) head.append(icon(SECTION_ICON[kind]));
    head.append(name, count);
    const list = el('div', 'sl-list');
    s.append(head, list);
    s._p = { head, name, count, list, rows: new Map() };
    return s;
  }
  const account = makeSection('account', 'account');
  account._p.name.textContent = 'Account & usage';
  account._p.count.remove();
  account._p.list.className = 'sl-accounts';
  body.appendChild(account);
  const sectionEls = new Map();

  /* ── rows ── */
  function makeRow() {
    const r = el('div', 'sl-row');
    r.tabIndex = -1;
    r.draggable = true;
    const stripe = el('span', 'sl-stripe');
    const logo = el('span', 'sl-logo');
    const img = el('img', 'sl-logo-img');
    const dot = el('span', 'sl-dot');
    logo.append(img, dot);
    const title = el('span', 'sl-title');
    const marks = el('span', 'sl-marks');
    const pinned = el('span', 'sl-pinned');
    pinned.appendChild(icon('pin'));
    pinned.title = 'Pinned: kept from being archived or deleted on its own';
    const meta = el('span', 'sl-meta');
    const away = el('span', 'sl-away sl-hidden');
    const time = el('span', 'sl-time');
    const acts = el('span', 'sl-actions');
    const pin = button('sl-act', 'Pin', icon('pin'));
    pin.dataset.act = 'pin';
    const unpin = button('sl-act', 'Unpin', icon('unpin'));
    unpin.dataset.act = 'unpin';
    const rename = button('sl-act', 'Rename', icon('pencil'));
    rename.dataset.act = 'rename';
    const archive = button('sl-act', 'Archive', icon('archive'));
    archive.dataset.act = 'archive';
    const restore = button('sl-act', 'Unarchive', icon('restore'));
    restore.dataset.act = 'unarchive';
    /* button() sets a title on each, and the browser would draw that tooltip over showTip's box. */
    for (const b of [pin, unpin, rename, archive, restore]) b.removeAttribute('title');
    acts.append(pin, unpin, rename, archive, restore);
    meta.append(away, pinned, time, acts);
    r.append(stripe, logo, title, marks, meta);
    r._p = { stripe, img, dot, title, marks, pinned, away, time, pin, unpin, rename, archive, restore };
    r._sig = '';
    return r;
  }
  const STRIPE_WORDS = { here: 'Open in this window', elsewhere: 'Open somewhere else', closed: 'Closed here lately' };
  const AWAY_WORDS = { window: 'Open in another VS Code window', terminal: 'Open in a terminal or another program' };
  function fillRow(r, row, place) {
    r._row = row;
    r._place = place;
    const sig = JSON.stringify([row, ui.searchOpen && ui.search, logoOf(row.s), model.restricted]);
    if (sig === r._sig) return;
    r._sig = sig;
    r.dataset.key = row.key;
    r.dataset.dot = row.dot || 'none';
    r.dataset.stripe = row.stripe || 'none';
    r.dataset.away = row.away || '';
    r._p.stripe.className = `sl-stripe s-${row.stripe || 'none'}`;
    r._p.stripe.title = STRIPE_WORDS[row.stripe] || '';
    setLogo(r._p.img, row.s);
    r._p.dot.className = `sl-dot d-${row.dot || 'none'}`;
    r.classList.toggle('sl-elsewhere', !!row.elsewhere);
    r.style.paddingLeft = row.depth ? `${8 + Math.min(row.depth, 3) * 16}px` : '';
    if (!r._editing) markTitle(r);
    r._p.title.style.color = themeColor(row.color);
    const marks = [];
    if (row.steward) { const c = el('span', 'sl-crown'); c.appendChild(icon('crown')); c.title = 'A supervisor: it looks after other conversations'; marks.push(c); }
    if (row.unread) { const u = el('span', 'sl-unread'); u.appendChild(icon('mail')); u.title = 'Has a reply you have not read'; marks.push(u); }
    for (const b of row.badges || []) { const x = el('span', b.dim ? 'sl-badge sl-dim' : 'sl-badge', b.text); if (b.tooltip) x.title = b.tooltip; marks.push(x); }
    if (row.worktree) marks.push(el('span', 'sl-badge', row.worktree));
    if (row.processes) marks.push(el('span', 'sl-procs', `· ${row.processes} processes`));
    r._p.marks.replaceChildren(...marks);
    r._p.pinned.classList.toggle('sl-hidden', !row.pinned);
    r._p.away.classList.toggle('sl-hidden', !row.away);
    if (row.away && r._p.away.dataset.away !== row.away) {
      r._p.away.dataset.away = row.away;
      r._p.away.replaceChildren(icon(row.away === 'window' ? 'window' : 'terminal'));
      r._p.away.title = AWAY_WORDS[row.away] || '';
    }
    setText(r._p.time, row.time || '');
    const ro = !!model.restricted;
    r._p.pin.classList.toggle('sl-hidden', ro || !row.pinnable);
    r._p.unpin.classList.toggle('sl-hidden', ro || !row.pinned);
    r._p.rename.classList.toggle('sl-hidden', ro || !row.ctx.renamable);
    r._p.archive.classList.toggle('sl-hidden', ro || !!row.archived);
    r._p.restore.classList.toggle('sl-hidden', ro || !row.archived);
    if (!r._editing) r.draggable = !row.archived && !ro;
    /* An open hover box for this row is updated with it. */
    if (r === hoverRow && !hoverBox.classList.contains('sl-hidden')) hoverBox.textContent = row.hover || row.title;
  }
  /* The title, with the search match highlighted. */
  function markTitle(r) {
    const title = r._row.title;
    const q = term();
    const at = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
    const t = r._p.title;
    if (at < 0) { if (t.childElementCount || t.textContent !== title) t.textContent = title; return; }
    t.textContent = '';
    t.append(title.slice(0, at), el('mark', 'sl-mark', title.slice(at, at + q.length)), title.slice(at + q.length));
  }
  /* A sub-agent's rows move with the nearest top-level row above them. */
  function heldOrder(list, rows) {
    const at = new Map([...list.children].map((r, i) => [r.dataset.key, i]));
    const blocks = [];
    for (const row of rows) { if (row.depth && blocks.length) blocks[blocks.length - 1].push(row); else blocks.push([row]); }
    const out = blocks.filter((b) => at.has(b[0].key)).sort((a, b) => (!!b[0].pinned - !!a[0].pinned) || (at.get(a[0].key) - at.get(b[0].key)));
    blocks.forEach((b, i) => { if (!at.has(b[0].key)) out.splice(Math.min(i, out.length), 0, b); });
    return out.flat();
  }
  function reconcile(list, cache, rows, place) {
    const seen = new Set();
    let i = 0;
    for (const row of rows) {
      seen.add(row.key);
      let r = cache.get(row.key);
      if (!r) { r = makeRow(); cache.set(row.key, r); }
      fillRow(r, row, place);
      const at = list.children[i];
      if (at !== r) list.insertBefore(r, at || null);
      i++;
    }
    for (const [k, r] of cache) if (!seen.has(k)) { if (r === hl) hl = null; if (r === ctxRow) ctxRow = null; r.remove(); cache.delete(k); }
  }

  /* ── the model ── */
  let model = null;
  let hl = null;
  let ctxRow = null;
  let selection = new Set();
  let anchor = '';
  let aimed = null;
  let shownFront = '';
  let pendingGroupRename = '';
  let lastDetail = '';
  /* Set when a section was last drawn in the held order rather than the model's, so that letting go has something to
     redraw. */
  let held = false;
  const still = () => body.matches(':hover') || !!cm || (!!hl && document.hasFocus() && root.contains(document.activeElement));
  function letRowsMove() {
    if (!held || still() || !model) return;
    held = false;
    apply(model);
  }

  function apply(next) {
    model = next || { sections: [], counts: {}, sources: [], accounts: [], menu: [], colors: [], logos: {}, empty: true };
    drawTop();
    drawAccounts(model.accounts || []);
    const hold = still();
    if (!hold) held = false;
    const keys = new Set();
    let i = 1;
    for (const sec of model.sections || []) {
      keys.add(sec.key);
      let se = sectionEls.get(sec.key);
      if (!se) { se = makeSection(sec.key, sec.kind); sectionEls.set(sec.key, se); }
      se._s = sec;
      se.dataset.kind = sec.kind;
      if (!se._p.name.isContentEditable) setText(se._p.name, sec.label);
      se._p.head._ctx = sec.kind === 'group' ? { group: true, made: !!sec.made, first: !!sec.first, last: !!sec.last } : null;
      se._p.head._groupId = sec.groupId || '';
      const rows = sec.rows || [];
      const drawn = hold ? heldOrder(se._p.list, rows) : rows;
      if (drawn.some((row, j) => row !== rows[j])) held = true;
      reconcile(se._p.list, se._p.rows, drawn, sec.key);
      const at = body.children[i];
      if (at !== se) body.insertBefore(se, at || null);
      i++;
    }
    for (const [k, se] of sectionEls) if (!keys.has(k)) { se.remove(); sectionEls.delete(k); }
    for (const se of [account, ...sectionEls.values()]) se.classList.toggle('sl-open', !ui.collapsed[se.dataset.key]);
    filter();
    front();
    selection = new Set([...selection].filter((k) => rowsOf(k).length));
    paintSelection();
    if (pendingGroupRename) startRenameGroup(pendingGroupRename);
  }

  function drawTop() {
    const srcs = (model.sources || []).filter((s) => (s.create || []).length);
    const cur = srcs.find((s) => s.id === model.newSource) || srcs[0];
    newBar.classList.toggle('sl-hidden', !cur || !!model.restricted);
    if (cur) {
      setLogo(newLogo, cur.id);
      newAgent.title = `New conversations start in ${cur.label}. Click to choose another agent`;
      newTab.disabled = !cur.create.includes('tab');
      newSide.disabled = !cur.create.includes('sidebar');
      newTab.classList.toggle('sl-primary', model.newWhere !== 'sidebar' && !newTab.disabled);
      newSide.classList.toggle('sl-primary', model.newWhere === 'sidebar' && !newSide.disabled);
      newTemp.disabled = !cur.temporary;
      newTemp.title = cur.temporary ? (tempOn ? 'The next new conversation is temporary: it stays out of this list and is deleted after it is closed. Click to turn off'
        : 'Make the next new conversation temporary: it stays out of this list and is deleted after it is closed')
        : `${cur.label} cannot start temporary conversations`;
      if (newTemp.disabled) setTempOn(false);
      fitNew();
    }
    const lines = (model.problems || []).map((p) => el('div', 'sl-note sl-warn', p.text));
    for (const n of model.notices || []) {
      const line = el('div', 'sl-note sl-notice');
      const img = el('img', 'sl-logo-img');
      setLogo(img, n.id);
      line.append(img, el('span', 'sl-note-text', n.text));
      for (const a of n.actions) { const b = button('sl-note-btn', '', a.label); b.dataset.notice = n.id; b.dataset.i = String(a.i); line.append(b); }
      lines.push(line);
    }
    if (model.restricted) {
      const line = el('div', 'sl-note sl-notice');
      const b = button('sl-note-btn', '', 'Manage Workspace Trust');
      b.dataset.tool = 'trust';
      line.append(el('span', 'sl-note-text', 'Restricted Mode: the list shows conversations and changes nothing. Some agents start only in a trusted workspace.'), b);
      lines.unshift(line);
    }
    notes.replaceChildren(...lines);
  }

  function drawAccounts(list) {
    account.classList.toggle('sl-hidden', !list.length);
    const sig = JSON.stringify([list, light(), Object.keys(model.logos || {}).length]);
    if (account._sig === sig) return;
    account._sig = sig;
    const kv = (r) => { const d = el('div', 'sl-kv'); d.append(el('span', 'sl-kv-k', r.label), el('span', 'sl-kv-v', r.value)); if (r.tooltip) d.title = r.tooltip; return d; };
    const parts = [];
    for (const a of list) {
      const block = el('div', 'sl-acct');
      const head = el('div', 'sl-acct-head');
      const img = el('img', 'sl-logo-img');
      setLogo(img, a.id);
      head.append(img, el('span', 'sl-acct-name', a.label));
      for (const l of a.info.links || []) {
        const b = button('sl-link', '', l.label);
        b.dataset.link = String(l.i);
        b.dataset.source = a.id;
        head.append(b);
      }
      block.append(head);
      const info = a.info;
      for (const r of info.rows) block.append(kv(r));
      for (const b of info.bars) {
        const u = el('div', 'sl-bar');
        const h = el('div', 'sl-kv');
        h.append(el('span', 'sl-kv-k', b.label), el('span', 'sl-kv-v', `${Math.round(b.percent)}%`));
        const track = el('div', 'sl-track'), fill = el('div', b.percent >= 80 ? 'sl-fill sl-high' : 'sl-fill');
        fill.style.width = `${b.percent}%`;
        track.appendChild(fill);
        u.append(h, track);
        if (b.resetsAt) u.append(el('div', 'sl-reset', resetText(b.resetsAt)));
        if (b.tooltip) u.title = b.tooltip;
        block.append(u);
      }
      /* The conversation's own figures come last, under a heading of their own, so that the account's lines above are not
         read as the conversation's. */
      if (info.conversation) {
        block.append(el('div', 'sl-acct-sub', 'This conversation'));
        if (info.conversation.title) { const t = el('div', 'sl-acct-conv', info.conversation.title); t.title = info.conversation.title; block.append(t); }
        for (const r of info.conversation.rows) block.append(kv(r));
      }
      parts.push(block);
    }
    account._p.list.replaceChildren(...parts);
  }
  const pad = (n) => String(n).padStart(2, '0');
  function resetText(ms) {
    const d = new Date(ms);
    const left = ms - Date.now();
    if (left <= 0) return 'resets now';
    if (left < 24 * 3600e3) { const m = Math.round(left / 60e3); return `resets ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`}`; }
    return `resets ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* The conversation in front is drawn as the current one, and scrolled to once. */
  function front() {
    const k = (model && model.front) || '';
    for (const r of root.querySelectorAll('.sl-row.sl-current')) if (r.dataset.key !== k) r.classList.remove('sl-current');
    if (!k) { shownFront = ''; return; }
    const rs = rowsOf(k).filter((r) => r._place !== 'closed');
    for (const r of rs) r.classList.add('sl-current');
    if (k === shownFront) return;
    shownFront = k;
    const r = rs.find(onScreen);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  function rowsOf(k) {
    const out = [];
    for (const se of sectionEls.values()) if (se._p.rows.has(k)) out.push(se._p.rows.get(k));
    return out;
  }

  /* ── filtering and searching ── */
  const term = () => (ui.searchOpen ? ui.search.trim() : '');
  function matches(row, q) {
    const s = q.toLowerCase();
    if (row.title.toLowerCase().includes(s) || (row.branch && row.branch.toLowerCase().includes(s))) return true;
    return s.length >= 4 && !/\s/.test(s) && row.id.toLowerCase().includes(s);
  }
  function passes(row) {
    if (ui.hidden[row.s]) return false;
    if (ui.filter === 'open' && !row.here) return false;
    if (ui.filter === 'running' && !row.runs) return false;
    if (ui.filter === 'needs' && !row.needs) return false;
    const q = term();
    return !q || matches(row, q);
  }
  const filtering = () => !!(term() || ui.filter !== 'all' || Object.keys(ui.hidden).some((k) => ui.hidden[k]));
  function filter() {
    if (!model) return;
    const on = filtering();
    let shown = 0;
    for (const se of sectionEls.values()) {
      let n = 0;
      for (const r of se._p.rows.values()) {
        const ok = passes(r._row);
        if (r._shown !== ok) { r._shown = ok; r.classList.toggle('sl-hidden', !ok); }
        if (!r._editing) markTitle(r);
        if (ok) n++;
      }
      if (se.dataset.key !== 'closed') shown += n;
      setText(se._p.count, String(n));
      const kind = se._s.kind;
      const empty = model.empty || (n === 0 && (on || kind === 'closed' || kind === 'archived' || (kind === 'group' && !se._s.made)
        || (kind === 'ungrouped' && (model.sections || []).length > 3)));
      se.classList.toggle('sl-hidden', empty);
      se.classList.toggle('sl-empty-group', kind === 'group' && n === 0);
    }
    for (const [k, b] of chipEls) {
      b.classList.toggle('sl-on', ui.filter === k);
      b.setAttribute('aria-pressed', ui.filter === k ? 'true' : 'false');
      setText(b.lastChild, String((model.counts || {})[k] || 0));
    }
    searchBox.classList.toggle('sl-hidden', !ui.searchOpen);
    clearBtn.classList.toggle('sl-hidden', !ui.search);
    if (searchInput.value !== ui.search) searchInput.value = ui.search;
    nullText.classList.toggle('sl-hidden', !model.empty || on);
    noneText.classList.toggle('sl-hidden', !(on && shown === 0 && !model.empty));
    wantDetail();
  }

  /* The host asks the source to read the dot and unread mark of rows on screen that it has not read yet. */
  function wantDetail() {
    const keys = visibleRows().filter((r) => r._row.detail === false).map((r) => r._row.key).slice(0, 200);
    const sig = keys.join('\n');
    if (sig === lastDetail) return;
    lastDetail = sig;
    if (keys.length) send({ kind: 'wantDetail', keys });
  }

  /* ── menus ── */
  /*
   * The page draws its menus itself, as Codex Plus's list does: VS Code's native menu can list only the commands in
   * package.json, so it cannot offer the user's groups, the agents or a colour swatch. The model carries the items and
   * when each is offered (menuItems in src/session-list.js).
   */
  const EDGE = 8;
  const SUB_CLOSE_MS = 150;
  const SUB_OPEN_MS = 250;
  let cm = null;
  let swallowClick = false;
  const inCtx = (t) => !!(cm && t && t.closest && t.closest('.sl-ctx'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* A when clause: `key` and `!key`, joined by &&. */
  function holds(when, ctx) {
    return String(when || '').split('&&').map((p) => p.trim()).filter(Boolean).every((p) => (p.charAt(0) === '!' ? !ctx[p.slice(1)] : !!ctx[p]));
  }
  function colorItems(keys) {
    const of = (k) => { const r = rowsOf(k)[0]; return r ? String(r._row.color || '').replace(/^charts\./, '') : ''; };
    const first = keys.length ? of(keys[0]) : '';
    const current = keys.every((k) => of(k) === first) ? first : null;
    return [{ label: 'Default', pick: '', swatch: '', checked: current === '' },
      ...(model.colors || []).map((c, i) => ({ label: cap(c.name), pick: c.name, swatch: themeColor(c.color), checked: current === c.name, separatorBefore: i === 0 }))];
  }
  /* Add to Group's submenu: the groups, except one that already holds every conversation in `keys`. */
  function groupItems(keys) {
    const holdsAll = (g) => keys.every((k) => { const se = sectionEls.get(`group:${g.id}`); return !!se && se._p.rows.has(k); });
    return (model.groups || []).filter((g) => !holdsAll(g)).map((g) => ({ label: g.name, pick: g.id }));
  }
  const agentItems = () => (model.sources || []).filter((s) => (s.create || []).length).map((s) => ({ label: s.label, pick: s.id, logo: s.id }));
  function itemsFor(ctx, keys) {
    const out = [];
    let last = '';
    for (const m of model.menu || []) {
      if (!holds(m.when, ctx)) continue;
      if (model.restricted && !['openTab', 'openSidebar', 'markUnread', 'markRead'].includes(m.name)) continue;
      const sub = m.submenu === 'color' ? colorItems(keys) : m.submenu === 'group' ? groupItems(keys) : m.submenu === 'agent' ? agentItems() : null;
      if (sub && !sub.length) continue;
      let label = m.title;
      if (m.rows) {
        const n = keys.filter((k) => { const rs = rowsOf(k); return rs.length > 0 && rs.every((r) => r._row && r._row[m.rows]); }).length;
        if (!n) continue;
        if (n > 1) label = String(m.plural || m.title).replace('{n}', String(n));
      }
      out.push({ label, name: m.name, submenu: sub, separatorBefore: out.length > 0 && m.group !== last });
      last = m.group;
    }
    return out;
  }
  function mainLeft(x, w, hasSub) {
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
    if (!hasSub || left + w - 2 + w <= window.innerWidth - EDGE || left - w + 2 >= EDGE) return left;
    return Math.max(EDGE, window.innerWidth - EDGE - w + 2 - w);
  }
  /* The left edge of a submenu beside its item, on its right or else its left, or null when the list is too narrow for
     either. */
  function subBeside(at, w) {
    if (at.right - 2 + w <= window.innerWidth - EDGE) return at.right - 2;
    if (at.left - w + 2 >= EDGE) return at.left - w + 2;
    return null;
  }
  const SUB_UNCOVERED = 48;
  /* The left edge of a submenu laid over part of its menu against the window's right edge, so that the item's label, at
     its start, stays in view; null when that leaves less than SUB_UNCOVERED pixels of the item. */
  function subOver(at, w) {
    const left = Math.max(EDGE, window.innerWidth - EDGE - w);
    return left - at.left >= SUB_UNCOVERED ? left : null;
  }
  const fitTop = (y, h) => Math.max(EDGE, Math.min(y, window.innerHeight - h - EDGE));
  /* `ticks`: the menu marks a choice, so each item has a column for its tick. */
  function itemButton(it, ticks) {
    const b = el('button', 'sl-ctx-item');
    b.type = 'button';
    b.setAttribute('role', it.checkbox ? 'menuitemcheckbox' : 'menuitem');
    const label = el('span', 'sl-ctx-label');
    if (ticks) { const c = el('span', it.checked ? 'sl-check sl-checked' : 'sl-check'); c.appendChild(icon('check')); label.append(c); }
    if (typeof it.swatch === 'string') { const s = el('span', it.swatch ? 'sl-swatch' : 'sl-swatch sl-swatch-none'); if (it.swatch) s.style.background = it.swatch; label.append(s); }
    if (it.logo) { const img = el('img', 'sl-logo-img'); setLogo(img, it.logo); label.append(img); }
    label.append(it.label);
    b.append(label);
    if (it.submenu) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.append(el('span', 'sl-ctx-chevron', '›')); }
    return b;
  }
  function menuBox(items, sub) {
    const box = el('div', sub ? 'sl-ctx sl-ctx-sub' : 'sl-ctx');
    box.setAttribute('role', 'menu');
    const ticks = items.some((it) => it.checkbox || it.checked);
    const buttons = items.map((it) => { if (it.separatorBefore) box.append(el('div', 'sl-ctx-sep')); const b = itemButton(it, ticks); box.append(b); return b; });
    /* The item under the pointer takes the focus, so only one item at a time looks chosen. */
    box.addEventListener('mouseover', (e) => { const b = e.target.closest('.sl-ctx-item'); if (b && document.activeElement !== b) b.focus({ preventScroll: true }); });
    return { box, buttons };
  }
  const rectOf = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.left + b.width, top: b.top, bottom: b.top + b.height }; };
  /* A menu given `rebuild` stays open after a pick and is drawn again from it, as the agents' checkboxes are. */
  function openCtx(x, y, items, run, { rebuild = null } = {}) {
    closeCtx();
    hideHover();
    const { box, buttons } = menuBox(items, false);
    buttons.forEach((b, i) => { b.addEventListener('mouseenter', () => hoverItem(i)); b.addEventListener('mouseleave', (e) => leaveSub(e, i)); });
    box.addEventListener('scroll', () => closeSub(false));
    /* A menu opened by a right-click appears under a still pointer, and the item there must not open its submenu over
       the rest of the menu. */
    box.addEventListener('mousemove', (e) => {
      if (!cm || cm.box !== box || cm.moved || Math.abs(e.clientX - cm.x) + Math.abs(e.clientY - cm.y) < 4) return;
      cm.moved = true;
      const i = cm.buttons.indexOf(e.target.closest && e.target.closest('.sl-ctx-item'));
      if (i >= 0) hoverItem(i);
    });
    root.appendChild(box);
    cm = { box, buttons, items, run, rebuild, back: document.activeElement || null, sub: null, subButtons: [], subAt: -1, timer: 0, x, y,
      moved: false, opening: -1, openTimer: 0 };
    box.style.left = `${mainLeft(x, box.offsetWidth, items.some((it) => it.submenu))}px`;
    box.style.top = `${fitTop(y, box.offsetHeight)}px`;
    if (buttons[0]) buttons[0].focus();
  }
  const stopTimer = () => { if (cm && cm.timer) { clearTimeout(cm.timer); cm.timer = 0; } };
  const stopOpen = () => { if (cm && cm.openTimer) { clearTimeout(cm.openTimer); cm.openTimer = 0; } if (cm) cm.opening = -1; };
  const closeSoon = () => { stopTimer(); cm.timer = setTimeout(() => { if (cm) { cm.timer = 0; closeSub(false); } }, SUB_CLOSE_MS); };
  function hoverItem(i) {
    if (!cm) return;
    if (cm.items[i].submenu) {
      if (cm.subAt === i) { stopTimer(); stopOpen(); return; }
      if (cm.sub && !cm.subInPlace) closeSoon();
      if (!cm.moved) return;
      stopOpen();
      cm.opening = i;
      cm.openTimer = setTimeout(() => { if (cm && cm.opening === i) { cm.openTimer = 0; cm.opening = -1; openSub(i, false, true); } }, SUB_OPEN_MS);
      return;
    }
    stopOpen();
    if (!cm.sub) return;
    closeSoon();
  }
  /* The pointer moved off a submenu or its item to somewhere outside both: the submenu closes after SUB_CLOSE_MS unless
     the pointer comes back first. A submenu that took the menu's place (see openSub below) is left open. */
  function leaveSub(e, i) {
    if (cm && cm.opening === i) stopOpen();
    if (!cm || !cm.sub || cm.subAt !== i || cm.subInPlace) return;
    const to = e.relatedTarget;
    if (to && (cm.sub.contains(to) || cm.buttons[i].contains(to))) return;
    stopTimer();
    cm.timer = setTimeout(() => { if (cm) { cm.timer = 0; closeSub(false); } }, SUB_CLOSE_MS);
  }
  /*
   * Opens item i's submenu beside it; resting the pointer on the item opens it, as do the right arrow key, Enter, Space
   * and a click. Where the list is too narrow for that, the submenu is laid over part of the menu, leaving the start of
   * the item in view. Where even that does not fit, it takes the menu's place, under a first line naming the item that
   * goes back to the menu; it then opens only on a click or a key, since one opened by the pointer passing over the
   * item would cover the rest of the menu.
   */
  function openSub(i, focus, byPointer = false) {
    stopTimer();
    stopOpen();
    if (cm.subAt !== i) {
      if (byPointer && cm.inPlace && cm.inPlace.has(i)) { closeSub(false); return; }
      closeSub(false);
      const parent = cm.buttons[i];
      const { box, buttons } = menuBox(cm.items[i].submenu, true);
      box.addEventListener('mouseenter', stopTimer);
      box.addEventListener('mouseleave', (e) => leaveSub(e, i));
      root.appendChild(box);
      const at = rectOf(parent);
      const beside = subBeside(at, box.offsetWidth);
      const left = beside === null ? subOver(at, box.offsetWidth) : beside;
      cm.subInPlace = left === null;
      if (left === null) {
        (cm.inPlace || (cm.inPlace = new Set())).add(i);
        if (byPointer) { box.remove(); return; }
        const back = el('button', 'sl-ctx-item sl-ctx-back');
        back.type = 'button';
        back.setAttribute('role', 'menuitem');
        back.append(el('span', 'sl-ctx-label', `‹ ${cm.items[i].label}`));
        box.prepend(back, el('div', 'sl-ctx-sep'));
        box.style.minWidth = `${cm.box.offsetWidth}px`;
        box.style.left = cm.box.style.left;
        box.style.top = `${fitTop(parseFloat(cm.box.style.top) || EDGE, box.offsetHeight)}px`;
        cm.box.style.visibility = 'hidden';
      } else {
        box.style.left = `${left}px`;
        box.style.top = `${fitTop(at.top - 3, box.offsetHeight)}px`;
      }
      parent.classList.add('sl-ctx-open');
      parent.setAttribute('aria-expanded', 'true');
      Object.assign(cm, { sub: box, subButtons: buttons, subAt: i });
    }
    if (focus && cm.subButtons[0]) cm.subButtons[0].focus();
  }
  function closeSub(focusParent) {
    stopTimer();
    if (!cm || !cm.sub) return;
    const parent = cm.buttons[cm.subAt];
    cm.sub.remove();
    cm.box.style.visibility = '';
    Object.assign(cm, { sub: null, subButtons: [], subAt: -1, subInPlace: false });
    parent.classList.remove('sl-ctx-open');
    parent.setAttribute('aria-expanded', 'false');
    if (focusParent) parent.focus();
  }
  function closeCtx() {
    if (!cm) return;
    const was = cm;
    stopTimer();
    stopOpen();
    const a = document.activeElement;
    const had = !a || a === document.body || was.box.contains(a) || (!!was.sub && was.sub.contains(a));
    if (was.sub) was.sub.remove();
    was.box.remove();
    cm = null;
    if (had && was.back && was.back.isConnected) was.back.focus({ preventScroll: true });
    letGoAim();
    letRowsMove();
  }
  function pressItem(b) {
    if (!cm) return;
    if (b.classList.contains('sl-ctx-back')) { closeSub(true); return; }
    const j = cm.subButtons.indexOf(b);
    const i = j >= 0 ? cm.subAt : cm.buttons.indexOf(b);
    const it = cm.items[i];
    if (!it) return;
    if (j < 0 && it.submenu) { openSub(i, true); return; }
    const run = cm.run, pick = j >= 0 ? it.submenu[j].pick : undefined;
    if (cm.rebuild) {
      run(it, pick);
      const { x, y, rebuild, back } = cm;
      openCtx(x, y, rebuild(), run, { rebuild });
      cm.back = back;
      if (cm.buttons[i]) cm.buttons[i].focus();
      return;
    }
    closeCtx();
    hoverQuiet = true;
    run(it, pick);
  }
  function ctxKey(e) {
    const inSub = !!cm.sub && cm.sub.contains(e.target);
    const list = inSub ? cm.subButtons : cm.buttons;
    const b = e.target.closest('.sl-ctx-item');
    const at = b ? list.indexOf(b) : -1;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!inSub) closeSub(false);
      const n = list.length, down = k === 'ArrowDown';
      const next = list[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n];
      if (next) next.focus();
    } else if (k === 'ArrowRight') {
      if (!inSub && at >= 0 && cm.items[at].submenu) openSub(at, true);
    } else if (k === 'ArrowLeft') {
      if (inSub) closeSub(true);
    } else if (k === 'Enter' || k === ' ') {
      if (b) pressItem(b);
    } else if (k === 'Escape') {
      if (cm.sub) closeSub(inSub); else closeCtx();
    } else if (k !== 'Tab') return;
    e.preventDefault();
  }
  /* A row's menu acts on the whole selection when the row is part of it. */
  const keysFor = (r) => (selection.has(r._row.key) ? [...selection] : [r._row.key]);
  function openRowMenu(r, e) {
    if (!model || !r._row || r._editing) return false;
    const keys = keysFor(r);
    const items = itemsFor(r._row.ctx || {}, keys);
    if (!items.length) return false;
    /* Delete... left out of an archived row's menu goes to the Agent Plus output channel with the reason this page was
       given, so that a missing one can be told apart from a stale one afterwards. */
    if (!items.some((it) => it.name === 'delete')) {
      const left = keys.map((k) => rowsOf(k)[0]).filter((x) => x && x._row && x._row.archived).map((x) => ({ key: x._row.key, why: x._row.deleteWhy || '' }));
      if (left.length) send({ kind: 'noDelete', rows: left });
    }
    const at = rectOf(r);
    const pointer = !!e && typeof e.clientX === 'number' && !!(e.clientX || e.clientY);
    openCtx(pointer ? e.clientX : at.left + 8, pointer ? e.clientY : at.bottom, items, (it, pick) => {
      if (it.name === 'rename') startRename(r);
      else send({ kind: 'act', name: it.name, keys, pick });
    });
    return true;
  }
  function openGroupMenu(head, e) {
    if (!model || !head._ctx || head.querySelector('.sl-editing')) return false;
    const items = itemsFor(head._ctx, []);
    if (!items.length) return false;
    const at = rectOf(head);
    const pointer = !!e && typeof e.clientX === 'number' && !!(e.clientX || e.clientY);
    const groupId = head._groupId;
    openCtx(pointer ? e.clientX : at.left + 8, pointer ? e.clientY : at.bottom, items, (it, pick) => {
      if (it.name === 'renameGroup') startRenameGroup(groupId);
      else send({ kind: 'groupAct', name: it.name, groupId, pick });
    });
    return true;
  }
  /* The New bar's agent menu. */
  function openAgentMenu() {
    const srcs = (model.sources || []).filter((s) => (s.create || []).length);
    const items = srcs.map((s) => ({ label: s.label, pick: s.id, logo: s.id, checked: s.id === model.newSource || (!model.newSource && s === srcs[0]) }));
    const at = rectOf(newBar);
    openCtx(at.left, at.bottom + 2, items, (it) => send({ kind: 'newSource', sourceId: it.pick, where: model.newWhere }));
  }
  /* Which agents' conversations the list shows: the filter tool in the view's title bar. */
  function openSourceMenu() {
    const items = () => (model.sources || []).map((s) => ({ label: s.label, pick: s.id, logo: s.id, checkbox: true, checked: !ui.hidden[s.id] }));
    const list = items();
    if (!list.length) return;
    openCtx(root.clientWidth - 8, 4, list, (it) => { if (ui.hidden[it.pick]) delete ui.hidden[it.pick]; else ui.hidden[it.pick] = true; keep(); filter(); }, { rebuild: items });
  }
  function aimAt(r, pointer) {
    ctxRow = r;
    aimed = { row: r, alone: !selection.has(r._row.key), pointer: !!pointer };
    if (aimed.alone) { anchor = r._row.key; select([r._row.key]); }
    highlight(r, false);
  }
  function letGoAim() {
    const a = aimed;
    aimed = null;
    if (!a) return;
    if (a.alone && selection.size === 1 && selection.has(a.row._row.key)) select([]);
    if (a.pointer && hl === a.row) highlight(null);
  }

  /* ── selection ── */
  const onScreen = (r) => !r.closest('.sl-hidden, .sl-section:not(.sl-open)');
  const visibleRows = () => [...root.querySelectorAll('.sl-row')].filter(onScreen);
  function paintSelection() {
    for (const r of root.querySelectorAll('.sl-row.sl-selected')) if (!selection.has(r.dataset.key)) r.classList.remove('sl-selected');
    for (const k of selection) for (const r of rowsOf(k)) r.classList.add('sl-selected');
  }
  function select(keys) {
    selection = new Set(keys);
    paintSelection();
    send({ kind: 'select', keys: [...selection] });
  }
  function highlight(r, scroll = true) {
    if (hl && hl !== r) hl.classList.remove('sl-hl');
    hl = r || null;
    if (hl) { hl.classList.add('sl-hl'); if (scroll) hl.scrollIntoView({ block: 'nearest' }); }
    else letRowsMove();
  }
  const openRow = (r) => { if (r && r._row) send({ kind: 'open', key: r._row.key }); };

  /* ── renaming in place ── */
  function editText(span, was, done) {
    span.textContent = was;
    span.contentEditable = 'true';
    span.classList.add('sl-editing');
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let over = false;
    const finish = (commit) => {
      if (over) return;
      over = true;
      span.removeEventListener('keydown', onKey);
      span.removeEventListener('blur', onBlur);
      const text = span.textContent.replace(/\s+/g, ' ').trim();
      span.contentEditable = 'false';
      span.classList.remove('sl-editing');
      span.scrollLeft = 0;
      done(commit && text && text !== was ? text : '');
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); root.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); root.focus(); }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    span.addEventListener('keydown', onKey);
    span.addEventListener('blur', onBlur);
  }
  function rowFor(k) {
    if (ctxRow && ctxRow.isConnected && ctxRow._row.key === k) return ctxRow;
    const all = rowsOf(k).filter((r) => r._place !== 'closed');
    return all.find(onScreen) || all[0] || null;
  }
  function startRename(r) {
    if (!r || r._editing || model.restricted) return;
    const k = r._row.key;
    expand(r);
    r._editing = true;
    r.draggable = false;
    hideHover();
    editText(r._p.title, r._row.title, (title) => {
      r._editing = false;
      r.draggable = !r._row.archived;
      if (title) { r._row = Object.assign({}, r._row, { title }); send({ kind: 'rename', key: k, title }); }
      markTitle(r);
    });
  }
  function startRenameGroup(groupId) {
    const se = sectionEls.get(`group:${groupId}`);
    if (!se) { pendingGroupRename = groupId; return; }
    pendingGroupRename = '';
    if (se._p.name.isContentEditable) return;
    se.classList.remove('sl-hidden');
    se._p.head.scrollIntoView({ block: 'nearest' });
    editText(se._p.name, se._s.label, (name) => {
      se._p.name.textContent = name || se._s.label;
      if (name) send({ kind: 'renameGroup', groupId, name });
    });
  }
  function expand(r) {
    const s = r.closest('.sl-section');
    if (s && !s.classList.contains('sl-open')) toggle(s.dataset.key);
  }
  function toggle(key) {
    ui.collapsed[key] = !ui.collapsed[key];
    keep();
    const s = key === 'account' ? account : sectionEls.get(key);
    if (s) s.classList.toggle('sl-open', !ui.collapsed[key]);
    wantDetail();
  }
  function openSearch() {
    ui.searchOpen = !ui.searchOpen;
    if (!ui.searchOpen) ui.search = '';
    keep();
    filter();
    if (ui.searchOpen) searchInput.focus();
  }

  /* ── the hover box ── */
  const HOVER_MS = 600;
  let hoverTimer = 0, hoverRow = null;
  function hideHover() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    hoverRow = null;
    hoverBox.classList.add('sl-hidden');
  }
  /* After a menu's item is picked, no hover box opens until the pointer moves: the row the pointer is left on would
     otherwise put one up, behind whatever the pick opens (a confirmation dialog). */
  let hoverQuiet = false;
  document.addEventListener('mousemove', (e) => {
    if (!hoverQuiet || !(e.movementX || e.movementY)) return;
    hoverQuiet = false;
    const r = e.target && e.target.closest ? e.target.closest('.sl-row') : null;
    if (r && !r._editing && !cm) showHover(r);
  });
  function showHover(r) {
    hideHover();
    if (hoverQuiet) return;
    hoverRow = r;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (!r.isConnected || hoverRow !== r || !r._row || cm || !r.matches(':hover')) return;
      hoverBox.textContent = r._row.hover || r._row.title;
      hoverBox.classList.remove('sl-hidden');
      const b = r.getBoundingClientRect();
      const w = hoverBox.offsetWidth, h = hoverBox.offsetHeight;
      hoverBox.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, b.left + 24)))}px`;
      hoverBox.style.top = `${Math.round(b.bottom + 4 + h <= window.innerHeight - 8 ? b.bottom + 4 : Math.max(8, b.top - h - 4))}px`;
    }, HOVER_MS);
  }

  /* A row's buttons show their own name in the hover box instead of the conversation's details. */
  const TIP_MS = 400;
  function showTip(b) {
    hideHover();
    if (hoverQuiet) return;
    hoverRow = b;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      if (!b.isConnected || hoverRow !== b || cm || !b.matches(':hover')) return;
      hoverBox.textContent = b.getAttribute('aria-label') || '';
      hoverBox.classList.remove('sl-hidden');
      const at = b.getBoundingClientRect();
      const w = hoverBox.offsetWidth, h = hoverBox.offsetHeight;
      hoverBox.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, at.left + at.width / 2 - w / 2)))}px`;
      hoverBox.style.top = `${Math.round(at.bottom + 4 + h <= window.innerHeight - 8 ? at.bottom + 4 : Math.max(8, at.top - h - 4))}px`;
    }, TIP_MS);
  }

  /* ── events ── */
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (swallowClick) { swallowClick = false; e.preventDefault(); return; }
    const ctxItem = t.closest('.sl-ctx-item');
    if (ctxItem) { pressItem(ctxItem); return; }
    if (t.closest('.sl-ctx')) return;
    const act = t.closest('.sl-act');
    if (act) {
      e.stopPropagation();
      const r = act.closest('.sl-row');
      if (!r || !r._row) return;
      if (act.dataset.act === 'rename') startRename(r);
      else send({ kind: 'act', name: act.dataset.act, keys: [r._row.key] });
      return;
    }
    const nb = t.closest('[data-notice]');
    if (nb) { send({ kind: 'noticeAction', sourceId: nb.dataset.notice, i: Number(nb.dataset.i) }); return; }
    if (t.closest('[data-tool="trust"]')) { send({ kind: 'trust' }); return; }
    const link = t.closest('[data-link]');
    if (link) { send({ kind: 'accountLink', sourceId: link.dataset.source, i: Number(link.dataset.link) }); return; }
    if (t.closest('[data-tool="agent"]')) { openAgentMenu(); return; }
    if (t.closest('[data-tool="temp"]')) { if (!newTemp.disabled) { setTempOn(!tempOn); drawTop(); } return; }
    const half = t.closest('[data-where]');
    if (half && !half.disabled) { send({ kind: 'create', sourceId: model.newSource, where: half.dataset.where, temporary: tempOn }); setTempOn(false); drawTop(); return; }
    const chip = t.closest('[data-chip]');
    if (chip) { const k = chip.dataset.chip; ui.filter = ui.filter === k && k !== 'all' ? 'all' : k; keep(); filter(); return; }
    if (t.closest('[data-tool="clear"]')) { ui.search = ''; keep(); filter(); searchInput.focus(); return; }
    const head = t.closest('[data-toggle]');
    if (head && !t.closest('.sl-editing')) { toggle(head.dataset.toggle); return; }
    const r = t.closest('.sl-row');
    if (!r || r._editing) return;
    const k = r._row.key;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(k)) next.delete(k); else next.add(k);
      anchor = k;
      select([...next]);
      highlight(r);
      return;
    }
    if (e.shiftKey && anchor) {
      const list = visibleRows();
      const a = list.findIndex((x) => x._row.key === anchor), b = list.indexOf(r);
      if (a >= 0 && b >= 0) { select([...new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x._row.key))]); highlight(r); return; }
    }
    anchor = k;
    select([]);
    highlight(null);
    openRow(r);
  });
  /* A right-click on a row or a group header opens the page's menu and cancels the event, which VS Code would otherwise
     answer with its own menu. */
  root.addEventListener('contextmenu', (e) => {
    hideHover();
    if (inCtx(e.target)) { e.preventDefault(); return; }
    closeCtx();
    const r = e.target.closest('.sl-row');
    ctxRow = r || null;
    if (r) { aimAt(r, true); if (openRowMenu(r, e)) e.preventDefault(); else letGoAim(); return; }
    const head = e.target.closest('.sl-head');
    if (head && openGroupMenu(head, e)) e.preventDefault();
  });
  root.addEventListener('mousedown', (e) => {
    swallowClick = false;
    if (cm && !inCtx(e.target)) { swallowClick = e.button === 0; closeCtx(); }
    hideHover();
  });
  root.addEventListener('wheel', (e) => { if (cm && (e.deltaX || e.deltaY) && !inCtx(e.target)) closeCtx(); }, { passive: true });
  root.addEventListener('mouseover', (e) => {
    const act = e.target.closest('.sl-row .sl-act');
    if (act) { if (act !== hoverRow) showTip(act); return; }
    const r = e.target.closest('.sl-row');
    if (r && r !== hoverRow && !r._editing) showHover(r);
    else if (!r && hoverRow) hideHover();
  });
  root.addEventListener('mouseleave', hideHover);
  body.addEventListener('mouseleave', letRowsMove);
  document.documentElement.addEventListener('mouseleave', letRowsMove);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) letRowsMove(); });
  root.addEventListener('focusout', () => setTimeout(letRowsMove, 0));
  root.addEventListener('scroll', () => { hideHover(); closeCtx(); }, { passive: true });

  searchInput.addEventListener('input', () => { ui.search = searchInput.value; keep(); filter(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (ui.search) ui.search = ''; else ui.searchOpen = false; keep(); filter(); root.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); root.focus(); highlight(visibleRows()[0]); }
    else if (e.key === 'Enter') { e.preventDefault(); const first = hl || visibleRows().find((r) => r._place !== 'closed'); if (first) openRow(first); }
  });

  root.addEventListener('keydown', (e) => {
    if (e.target === searchInput || e.target.isContentEditable) return;
    if (inCtx(e.target)) { ctxKey(e); return; }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = (e.target.closest && e.target.closest('.sl-row')) || hl;
      if (r && r._row && onScreen(r)) { e.preventDefault(); closeCtx(); aimAt(r); if (!openRowMenu(r, null)) letGoAim(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = visibleRows();
      if (!list.length) return;
      const at = hl ? list.indexOf(hl) : -1;
      highlight(list[e.key === 'ArrowDown' ? Math.min(list.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)]);
      return;
    }
    if (e.key === 'Enter' && hl) { e.preventDefault(); openRow(hl); return; }
    if (e.key === 'F2' && hl) { e.preventDefault(); startRename(hl); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCtx();
      if (ui.search) { ui.search = ''; keep(); filter(); } else if (selection.size) select([]); else highlight(null);
      return;
    }
    /* Typing in the list starts a search, as in Claude Code's list. */
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      ui.searchOpen = true;
      ui.search += e.key;
      keep();
      filter();
      searchInput.focus();
      e.preventDefault();
    }
  });

  /* ── dragging rows onto a group, or onto Ungrouped ── */
  const DRAG = 'application/x-agent-plus-sessions';
  let dragging = null, dragImage = null;
  const dropImage = () => { if (dragImage) { dragImage.remove(); dragImage = null; } };
  root.addEventListener('dragstart', (e) => {
    const r = e.target.closest && e.target.closest('.sl-row');
    if (!r || r._editing || r._row.archived || model.restricted) return;
    hideHover();
    const keys = (selection.has(r._row.key) ? [...selection] : [r._row.key]).filter((k) => !rowsOf(k).some((x) => x._row && x._row.archived));
    dragging = keys;
    e.dataTransfer.setData(DRAG, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = 'move';
    dropImage();
    dragImage = el('div', 'sl-drag', keys.length === 1 ? r._row.title : `${keys.length} conversations`);
    root.appendChild(dragImage);
    if (typeof e.dataTransfer.setDragImage === 'function') e.dataTransfer.setDragImage(dragImage, -12, -12);
  });
  root.addEventListener('dragend', () => { dragging = null; dropImage(); for (const h of root.querySelectorAll('.sl-drop')) h.classList.remove('sl-drop'); });
  /* Dropping on a group's rows works like dropping on its header; the section is lit as one block while a drag is over it. */
  const target = (e) => {
    const s = e.target.closest && e.target.closest('.sl-section');
    const se = s && sectionEls.get(s.dataset.key);
    return se === s && (se._s.kind === 'group' || se._s.kind === 'ungrouped') ? s : null;
  };
  root.addEventListener('dragover', (e) => {
    const h = target(e);
    if (!h || !dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    h.classList.add('sl-drop');
  });
  root.addEventListener('dragleave', (e) => { const h = target(e); if (h && !h.contains(e.relatedTarget)) h.classList.remove('sl-drop'); });
  root.addEventListener('drop', (e) => {
    const h = target(e);
    if (!h) return;
    e.preventDefault();
    h.classList.remove('sl-drop');
    let keys = dragging;
    try { keys = JSON.parse(e.dataTransfer.getData(DRAG) || 'null') || keys; } catch (_) { /* the drag's own list */ }
    dragging = null;
    if (Array.isArray(keys) && keys.length) send({ kind: 'move', keys, section: h.dataset.key });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'model') apply(msg.model);
    else if (msg.type === 'search') openSearch();
    else if (msg.type === 'filter') { if (cm) closeCtx(); else openSourceMenu(); }
    else if (msg.type === 'startRename' && typeof msg.key === 'string') startRename(rowFor(msg.key));
    else if (msg.type === 'startRenameGroup' && typeof msg.groupId === 'string') startRenameGroup(msg.groupId);
  });
  /* VS Code changes the body's theme class when the theme changes; the logos have a light and a dark form. */
  new MutationObserver(() => { if (model) { account._sig = ''; apply(model); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('blur', () => { hideHover(); closeCtx(); highlight(null); letRowsMove(); });
  window.addEventListener('resize', closeCtx);
  send({ kind: 'ready' });
}());
