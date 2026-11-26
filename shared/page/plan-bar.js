// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/page/plan-bar.js; sync-shared.js copies it, so edit it there.

/*
 * The plan bar: one line above an agent's input box. Claude Code Plus draws it in Claude Code's panel, Codex Plus in the
 * Codex page and OpenCode Agent Plus in its chat page, each from the summary Agent Plus gives for the conversation
 * (planSummary in docs/protocol.md). Exported as one global, agentPlusPlanBar; under Node it is also a module, for the
 * tests. The source is ASCII and ES5, like the page scripts.
 *
 * It counts the open rows by state in bubbles, one for each state of BUBBLES that has rows, and the rows waiting for
 * the user's answer in a solid "N to decide" part; a row that asks is counted there only, so the numbers add up to the
 * rows still open but parked. Narrower than COMPACT_BELOW, it drops the word Plan and the arrow, and "to decide" keeps
 * only its number. Hovering a bubble lists its rows, hovering "to decide" its questions, and hovering the rest of the
 * bar every open row.
 */
var agentPlusPlanBar = (function () {
  'use strict';
  /* Below this measured width, in CSS pixels, the bar is compact. Four bubbles and "to decide" still fit below it. */
  var COMPACT_BELOW = 400;
  var HYSTERESIS = 24;
  /* A hover list shows at most this many rows, the same limit as the summary's. */
  var MAX_LIST = 30;
  var HOVER_MS = 350;
  var MARK = 'data-agent-plus-plan-bar';

  /* The states that get a bubble, in their order on the bar: what is moving, what is held up, what is still being talked
     over, what waits to start. Parked and done rows have none. WORD names a state in the hover and the spoken label. */
  var BUBBLES = ['doing', 'waiting', 'discussing', 'todo'];
  var WORD = { doing: 'doing', waiting: 'waiting', discussing: 'discussing', todo: 'to do', parked: 'parked', done: 'done' };

  /* The colours of the work plan view's state icons (LOOK in src/workplan-view.js), as the page's theme variables. A
     bubble draws its icon in its state's colour on a tint of it: TINT percent of the colour, more in light themes, whose
     orange and yellow are so close that lighter tints of them look the same. */
  var COLOR = {
    done: 'var(--vscode-charts-green, #89d185)',
    doing: 'var(--vscode-charts-blue, #3794ff)',
    waiting: 'var(--vscode-charts-orange, #d18616)',
    discussing: 'var(--vscode-charts-yellow, #cca700)',
    todo: 'var(--vscode-charts-purple, #b180d7)',
    parked: 'var(--vscode-descriptionForeground, #8c8c8c)'
  };
  var TINT = { dark: 24, light: 45 };
  /* "to decide" is filled with the colour of the question mark the work plan view gives a row waiting for the user's
     answer (src/workplan-view.js), with dark words on it; the high contrast themes make that colour a deep orange or a
     dark blue, where the words are white. Not the status bar's warning colour, which some themes make red. */
  var ASK = 'var(--vscode-charts-orange, #d18616)';
  var ASK_TEXT = '#1f1f1f';
  var MUTED = 'var(--vscode-descriptionForeground, #8c8c8c)';

  /* 16 by 16 shapes in the spirit of the work plan view's icons; each takes the colour of the text around it. */
  var svg = function (body) { return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' + body + '</svg>'; };
  var ICON = {
    list: svg('<g fill="currentColor"><rect x="1" y="2.5" width="2.5" height="2.5" rx=".5"/><rect x="1" y="6.75" width="2.5" height="2.5" rx=".5"/>'
      + '<rect x="1" y="11" width="2.5" height="2.5" rx=".5"/><rect x="5.5" y="3" width="9.5" height="1.5" rx=".75"/>'
      + '<rect x="5.5" y="7.25" width="9.5" height="1.5" rx=".75"/><rect x="5.5" y="11.5" width="9.5" height="1.5" rx=".75"/></g>'),
    doing: svg('<path fill="currentColor" d="M4 2.5v11l9.5-5.5z"/>'),
    waiting: svg('<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/></g>'),
    discussing: svg('<path fill="none" stroke="currentColor" stroke-width="1.4" d="M2 3h8.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1H6L3.5 12V9.5H2'
      + 'a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM13.5 6H14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1V14l-2-2H8"/>'),
    todo: svg('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
    parked: svg('<g fill="currentColor"><rect x="4" y="3" width="2.5" height="10" rx=".5"/><rect x="9.5" y="3" width="2.5" height="10" rx=".5"/></g>'),
    done: svg('<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.75 8.25l2.25 2.25 4.25-4.5" fill="none" stroke="var(--vscode-editor-background, #1e1e1e)" stroke-width="1.6"/>'),
    question: svg('<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.25"/>'
      + '<path d="M6.1 6.2a1.95 1.95 0 1 1 2.9 1.7c-.6.35-1 .8-1 1.5v.4" stroke-linecap="round"/></g><circle cx="8" cy="11.6" r=".9" fill="currentColor"/>'),
    chevron: svg('<path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5"/>')
  };

  var pill = 'display:flex;align-items:center;gap:4px;flex:none;box-sizing:border-box;height:18px;border-radius:9px;font-variant-numeric:tabular-nums;';
  var CSS = '[' + MARK + ']{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-width:0;height:26px;'
    + 'margin:0 0 6px;padding:0 8px 0 10px;overflow:hidden;cursor:pointer;user-select:none;font-size:12px;line-height:18px;'
    + 'white-space:nowrap;color:var(--vscode-foreground, #ccc);background:var(--vscode-input-background, #252526);'
    + 'border:1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128,128,128,.35)));border-radius:6px;'
    + '--apb-tint:' + TINT.dark + '%}'
    + 'body.vscode-light [' + MARK + '],body.vscode-high-contrast-light [' + MARK + ']{--apb-tint:' + TINT.light + '%}'
    + '[' + MARK + ']:hover{border-color:var(--vscode-focusBorder, #007fd4)}'
    + '[' + MARK + ']:focus-visible{outline:1px solid var(--vscode-focusBorder, #007fd4);outline-offset:-1px}'
    + '[' + MARK + '] svg{display:block;flex:none}'
    + '.apb-icon{display:flex;flex:none;color:' + MUTED + '}'
    + '.apb-name{flex:none;font-weight:700}'
    + '.apb-b{' + pill + 'padding:0 7px 0 5px}'
    + '.apb-text{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.apb-dim{color:' + MUTED + '}'
    + '.apb-gap{flex:1 1 0;min-width:0}'
    + '.apb-q{' + pill + 'padding:0 8px 0 5px;font-weight:600;color:' + ASK_TEXT + ';background:' + ASK + '}'
    + 'body.vscode-high-contrast .apb-q,body.vscode-high-contrast-light .apb-q{color:#fff}'
    + '.apb-q:hover{background:color-mix(in srgb, ' + ASK + ' 82%, white)}'
    + '.apb-q:focus-visible{outline:1px solid var(--vscode-focusBorder, #007fd4);outline-offset:1px}'
    + '.apb-q .apb-icon{color:inherit}'
    + '.apb-chev{display:flex;flex:none;color:' + MUTED + '}'
    + '[' + MARK + ']:hover .apb-chev{color:var(--vscode-foreground, #ccc)}'
    + '[' + MARK + '-list]{position:fixed;z-index:1000;pointer-events:none;box-sizing:border-box;max-width:420px;padding:6px 8px;'
    + 'font-size:12px;line-height:18px;color:var(--vscode-foreground, #ccc);'
    + 'background:var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));'
    + 'border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));border-radius:6px}'
    + '.apb-now{white-space:normal;overflow-wrap:anywhere;margin:0 0 4px}'
    + '.apb-li{display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden}'
    + '.apb-li .apb-text{flex:1;min-width:0}'
    + '.apb-head,.apb-more{color:' + MUTED + '}';

  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  /*
   * What the bar draws for `summary` at `width`, or null for no bar: { compact, bubbles: [{ state, n }], done, questions:
   * the "to decide" text or '', label: the bar's spoken text, lists: the hover list for each part, under the bubble's
   * state, 'ask' for "to decide" and '' for the rest of the bar, each { now, head, rows: [{ state, text, depth }], more } }.
   * `wasCompact` is the form drawn last, for the hysteresis. A width of 0 is one not measured yet, and draws the full bar.
   * A summary without `asking` (from a core older than the bubbles) counts its asking rows in their states' bubbles too.
   */
  function model(summary, width, wasCompact) {
    var s = summary;
    if (!s || typeof s !== 'object' || !(s.total > 0 || s.allDone)) return null;
    var counts = s.counts || {}, asking = s.asking || {};
    var compact = width > 0 && width < (wasCompact ? COMPACT_BELOW + HYSTERESIS : COMPACT_BELOW);
    var q = +s.questions || 0;
    var open = Array.isArray(s.open) ? s.open : [];
    var rows = [];
    for (var j = 0; j < open.length; j++) {
      var r = open[j];
      if (r && r.title) rows.push({ state: r.state, text: (r.number ? r.number + ' ' : '') + r.title, depth: Math.max(1, +r.depth || 1), asks: !!r.asks });
    }
    var take = function (list) {
      var out = [];
      for (var k = 0; k < list.length && out.length < MAX_LIST; k++) out.push({ state: list[k].state, text: list[k].text, depth: list[k].depth });
      return out;
    };
    var left = Math.max(0, (+s.total || 0) - (+s.done || 0));
    var now = s.current && s.current.title ? (s.current.number ? s.current.number + ' ' : '') + s.current.title : '';
    var lists = {};
    if (left) {
      var all = take(rows);
      lists[''] = { now: s.allDone ? '' : now, head: plural(left, 'row', 'rows') + ' not done', rows: all, more: Math.max(0, left - all.length) };
    }
    var bubbles = [], said = [];
    for (var i = 0; i < BUBBLES.length; i++) {
      var state = BUBBLES[i];
      var n = Math.max(0, (+counts[state] || 0) - (+asking[state] || 0));
      if (!n) continue;
      bubbles.push({ state: state, n: n });
      said.push(n + ' ' + WORD[state]);
      var mine = [];
      for (var m = 0; m < rows.length; m++) if (rows[m].state === state && !rows[m].asks) mine.push({ state: state, text: rows[m].text, depth: 1 });
      var shown = take(mine);
      lists[state] = { now: '', head: n + ' ' + WORD[state], rows: shown, more: Math.max(0, n - shown.length) };
    }
    if (q) {
      var asks = Array.isArray(s.asks) ? s.asks : [], qs = [];
      for (var a = 0; a < asks.length; a++) {
        var x = asks[a];
        if (x && (x.question || x.title)) qs.push({ state: 'question', text: (x.number ? x.number + ' ' : '') + (x.question || x.title), depth: 1 });
      }
      var shownQ = take(qs);
      lists.ask = { now: '', head: plural(q, 'question', 'questions') + ' for you', rows: shownQ, more: Math.max(0, q - shownQ.length) };
    }
    var label = 'Work plan: ' + (s.allDone ? 'all rows done' : said.length ? said.join(', ') : plural(left, 'row', 'rows') + ' open')
      + (q ? '; ' + plural(q, 'question waits', 'questions wait') + ' for your answer' : '');
    return {
      compact: compact,
      bubbles: bubbles,
      done: !!s.allDone,
      questions: q ? (compact ? String(q) : q + ' to decide') : '',
      label: label,
      lists: lists
    };
  }

  var styled = {};
  function ensureStyle(doc) {
    var head = doc.head || doc.documentElement;
    if (!head) return;
    if (styled.doc === doc && styled.el && styled.el.parentNode) return;
    var el = doc.createElement('style');
    el.setAttribute(MARK + '-style', '1');
    el.textContent = CSS;
    head.appendChild(el);
    styled = { doc: doc, el: el };
  }

  var part = function (doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  var icon = function (doc, name, color) {
    var e = part(doc, 'span', 'apb-icon');
    if (color) e.style.color = color;
    e.innerHTML = ICON[name] || ICON.todo;
    return e;
  };

  /*
   * A bar for document `doc`. `opts.onOpen()` runs on a click on the bar or Enter on it, `opts.onAnswer()` on a click
   * on "to decide"; `opts.css` is added to the bar's own style, for a page that wants it closer to its input box.
   * Returns { el, update(summary), fit(width), model(), destroy() }.
   */
  function create(doc, opts) {
    var o = opts || {};
    ensureStyle(doc);
    var el = doc.createElement('div');
    el.setAttribute(MARK, '1');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    if (o.css) el.style.cssText = o.css;
    el.style.display = 'none';
    /* `key` is the part the pointer is over: a bubble's state, 'ask', or '' for the rest of the bar. */
    var shown = null, summary = null, width = 0, compact = false, drawn = '', list = null, timer = 0, hovering = false, key = '';
    var win = doc.defaultView || (typeof window === 'object' ? window : null);
    var call = function (fn) { if (typeof fn === 'function') { try { fn(); } catch (e) { /* the page's own handler */ } } };

    function hideList() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (list && list.parentNode) list.parentNode.removeChild(list);
      list = null;
    }
    function showList() {
      timer = 0;
      var l = hovering && shown && shown.lists ? shown.lists[key] : null;
      if (!l || !el.parentNode || !doc.body) return;
      if (list && list.parentNode) list.parentNode.removeChild(list);
      var box = part(doc, 'div', '');
      box.setAttribute(MARK + '-list', '1');
      if (l.now) box.appendChild(part(doc, 'div', 'apb-now', l.now));
      box.appendChild(part(doc, 'div', 'apb-head', l.head));
      for (var i = 0; i < l.rows.length; i++) {
        var r = l.rows[i], li = part(doc, 'div', 'apb-li');
        li.style.paddingLeft = ((r.depth - 1) * 12) + 'px';
        li.appendChild(icon(doc, r.state, r.state === 'question' ? ASK : COLOR[r.state]));
        li.appendChild(part(doc, 'span', 'apb-text', r.text));
        box.appendChild(li);
      }
      if (l.more) box.appendChild(part(doc, 'div', 'apb-more', 'and ' + l.more + ' more' + (key ? '' : ' open')));
      doc.body.appendChild(box);
      list = box;
      var at = null, size = null;
      try { at = el.getBoundingClientRect(); size = box.getBoundingClientRect(); } catch (e) { at = null; }
      if (!at || !size) return;
      var vw = (win && +win.innerWidth) || 0, vh = (win && +win.innerHeight) || 0;
      var left = Math.max(8, vw ? Math.min(vw - (size.width || 0) - 8, at.left || 0) : at.left || 0);
      var above = (at.top || 0) - (size.height || 0) - 6;
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(above >= 8 || !vh ? Math.max(8, above) : Math.min(vh - (size.height || 0) - 8, (at.bottom || 0) + 6)) + 'px';
    }

    function paint() {
      var m = model(summary, width, compact);
      shown = m;
      if (!m) {
        drawn = '';
        el.style.display = 'none';
        hideList();
        return;
      }
      compact = m.compact;
      if (el.style.display === 'none') el.style.display = '';
      var json = JSON.stringify(m);
      if (json === drawn) return;
      drawn = json;
      while (el.firstChild) el.removeChild(el.firstChild);
      el.setAttribute('aria-label', m.label);
      el.setAttribute('data-compact', m.compact ? '1' : '0');
      el.appendChild(icon(doc, 'list', ''));
      if (!m.compact) el.appendChild(part(doc, 'span', 'apb-name', 'Plan'));
      for (var i = 0; i < m.bubbles.length; i++) {
        var b = part(doc, 'span', 'apb-b');
        b.setAttribute('data-state', m.bubbles[i].state);
        b.setAttribute('data-key', m.bubbles[i].state);
        b.style.background = 'color-mix(in srgb, ' + COLOR[m.bubbles[i].state] + ' var(--apb-tint), transparent)';
        b.appendChild(icon(doc, m.bubbles[i].state, COLOR[m.bubbles[i].state]));
        b.appendChild(part(doc, 'span', '', String(m.bubbles[i].n)));
        el.appendChild(b);
      }
      if (m.done) {
        el.appendChild(icon(doc, 'done', COLOR.done));
        if (!m.compact) el.appendChild(part(doc, 'span', 'apb-text apb-dim', 'All rows done'));
      }
      el.appendChild(part(doc, 'span', 'apb-gap'));
      if (m.questions) {
        var q = part(doc, 'span', 'apb-q');
        q.setAttribute('role', 'button');
        q.setAttribute('tabindex', '0');
        q.setAttribute('data-key', 'ask');
        q.setAttribute('aria-label', 'Answer the questions in the plan');
        q.appendChild(icon(doc, 'question', ''));
        q.appendChild(part(doc, 'span', '', m.questions));
        q.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); hideList(); call(o.onAnswer); });
        q.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault(); ev.stopPropagation(); call(o.onAnswer);
        });
        el.appendChild(q);
      }
      if (!m.compact) {
        var chev = icon(doc, 'chevron', '');
        chev.className = 'apb-chev';
        el.appendChild(chev);
      }
      if (list) showList();
    }

    /* The part of the bar `target` is in. */
    var keyOf = function (target) {
      for (var n = target; n && n !== el; n = n.parentNode) {
        var k = n.getAttribute ? n.getAttribute('data-key') : null;
        if (k) return k;
      }
      return '';
    };
    el.addEventListener('click', function (ev) { ev.preventDefault(); hideList(); call(o.onOpen); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault(); call(o.onOpen);
    });
    /* A list comes after the pointer rests a moment; moved to another part while one shows, the list changes at once. */
    el.addEventListener('mouseover', function (ev) {
      var next = keyOf(ev.target);
      if (hovering && next === key && (list || timer)) return;
      var showing = !!list;
      hovering = true;
      key = next;
      hideList();
      if (showing) showList();
      else timer = setTimeout(showList, HOVER_MS);
    });
    el.addEventListener('mouseleave', function () { hovering = false; key = ''; hideList(); });

    var watcher = null;
    if (win && typeof win.ResizeObserver === 'function') {
      try {
        watcher = new win.ResizeObserver(function () {
          var w = 0;
          try { w = el.getBoundingClientRect().width; } catch (e) { w = 0; }
          if (w > 0) bar.fit(w);
        });
        watcher.observe(el);
      } catch (e) { watcher = null; }
    }

    var bar = {
      el: el,
      /* The summary to draw, or null to hide the bar. */
      update: function (next) { summary = next && typeof next === 'object' ? next : null; paint(); },
      /* For a page that knows the bar's width before the bar is laid out. */
      fit: function (w) {
        var next = +w > 0 ? +w : 0;
        if (!next || next === width) return;
        width = next;
        paint();
      },
      model: function () { return shown; },
      destroy: function () {
        hideList();
        if (watcher) { try { watcher.disconnect(); } catch (e) { /* gone */ } watcher = null; }
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
    return bar;
  }

  return { COMPACT_BELOW: COMPACT_BELOW, HYSTERESIS: HYSTERESIS, MAX_LIST: MAX_LIST, BUBBLES: BUBBLES, WORD: WORD, COLOR: COLOR, TINT: TINT,
    ASK: ASK, ASK_TEXT: ASK_TEXT, HOVER_MS: HOVER_MS, MARK: MARK, model: model, create: create };
})();
if (typeof module === 'object' && module) module['exports'] = agentPlusPlanBar;
