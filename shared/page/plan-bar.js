// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/page/plan-bar.js; sync-shared.js copies it, so edit it there.

/*
 * The plan bar: one line above an agent's input box. Claude Code Plus draws it in Claude Code's panel and Codex Plus in
 * the Codex page, each from the summary Agent Plus gives for the conversation (planSummary in docs/protocol.md).
 * Exported as one global, agentPlusPlanBar; under Node it is also a module, for the tests. The source is ASCII and ES5,
 * like the page scripts.
 *
 * Narrower than COMPACT_BELOW, the bar drops the track and the current row. Hovering shows the current row's whole
 * title and lists the rows still open.
 */
var agentPlusPlanBar = (function () {
  'use strict';
  /* Below this measured width, in CSS pixels, the bar keeps only "Plan", the count, the number of questions and the
     arrow. At this width the full bar still leaves its current row about a hundred pixels. */
  var COMPACT_BELOW = 400;
  var HYSTERESIS = 24;
  /* The track's width in CSS pixels, whatever the plan holds; more rows only make the segments thinner.
     Every segment drawn is at least SEGMENT_MIN wide, so a state with one row among many still shows. */
  var TRACK_WIDTH = 72;
  var SEGMENT_MIN = 2;
  /* The hover lists at most this many open rows, the same limit as the summary's. */
  var MAX_LIST = 30;
  var HOVER_MS = 350;
  var MARK = 'data-agent-plus-plan-bar';

  /*
   * What the bar counts, decided here and nowhere else. A plan keeps every row it was ever given, so done against total
   * says little about a long conversation; what is left does. So the track shows the open rows by state, in the order
   * below (what is moving, then what waits to start), and the count says how many are open. To count done against total
   * instead, put 'done' first in SEGMENTS and have countOf() return s.done + '/' + s.total: the summary carries both.
   * COUNT_ROOM is the longest count the layout keeps room for, so the title does not move as the count grows.
   */
  var SEGMENTS = ['doing', 'waiting', 'discussing', 'todo', 'parked'];
  var countOf = function (s) {
    var left = Math.max(0, (+s.total || 0) - (+s.done || 0));
    return left ? left + ' open' : '';
  };
  var COUNT_ROOM = '999 open';

  /* The colours of the work plan view's state icons (LOOK in src/workplan-view.js), as the page's theme variables. */
  var COLOR = {
    done: 'var(--vscode-charts-green, #89d185)',
    doing: 'var(--vscode-charts-blue, #3794ff)',
    waiting: 'var(--vscode-charts-orange, #d18616)',
    discussing: 'var(--vscode-charts-yellow, #cca700)',
    todo: 'var(--vscode-charts-purple, #b180d7)',
    parked: 'var(--vscode-descriptionForeground, #8c8c8c)'
  };
  /* The warning yellow that Agent Plus's status bar entry takes while conversations wait for the user. The questions
     part uses it too. */
  var ASK = 'var(--vscode-statusBarItem-warningBackground, #b89500)';
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
    chevron: svg('<path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.5"/>')
  };

  var CSS = '[' + MARK + ']{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-width:0;height:26px;'
    + 'margin:0 0 6px;padding:0 8px 0 10px;overflow:hidden;cursor:pointer;user-select:none;font-size:12px;line-height:18px;'
    + 'white-space:nowrap;color:var(--vscode-foreground, #ccc);background:var(--vscode-input-background, #252526);'
    + 'border:1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128,128,128,.35)));border-radius:6px}'
    + '[' + MARK + ']:hover{border-color:var(--vscode-focusBorder, #007fd4)}'
    + '[' + MARK + ']:focus-visible{outline:1px solid var(--vscode-focusBorder, #007fd4);outline-offset:-1px}'
    + '[' + MARK + '] svg{display:block;flex:none}'
    + '.apb-icon{display:flex;flex:none;color:' + MUTED + '}'
    + '.apb-name{flex:none;font-weight:700}'
    + '.apb-track{display:flex;flex:none;gap:1px;width:' + TRACK_WIDTH + 'px;height:6px;border-radius:3px;overflow:hidden;'
    + 'background:var(--vscode-input-border, rgba(128,128,128,.35))}'
    + '.apb-seg{display:block;height:100%;min-width:' + SEGMENT_MIN + 'px}'
    + '.apb-count{flex:none;box-sizing:content-box;text-align:right;font-variant-numeric:tabular-nums;color:' + MUTED + '}'
    + '.apb-sep{flex:none;color:' + MUTED + '}'
    + '.apb-row{display:flex;align-items:center;gap:5px;flex:1 1 0;min-width:0;overflow:hidden}'
    + '.apb-text{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.apb-dim{color:' + MUTED + '}'
    + '.apb-gap{flex:1 1 0;min-width:0}'
    + '.apb-q{display:flex;align-items:center;gap:5px;flex:none;padding:0 8px;border-radius:9px;'
    + 'background:color-mix(in srgb, ' + ASK + ' 30%, transparent)}'
    + '.apb-q:hover{background:color-mix(in srgb, ' + ASK + ' 48%, transparent)}'
    + '.apb-q:focus-visible{outline:1px solid var(--vscode-focusBorder, #007fd4)}'
    + '.apb-dot{display:block;flex:none;width:7px;height:7px;border-radius:50%;background:' + ASK + '}'
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
   * What the bar draws for `summary` at `width`, or null for no bar: { compact, segments: [{ state, n }], count,
   * current: { state, text, dim } or null, questions: the questions part's text or '', label: the bar's spoken text, list:
   * { now, head, rows: [{ state, text, depth }], more } or null }. `wasCompact` is the form drawn last, for the
   * hysteresis. A width of 0 is one not measured yet, and draws the full bar.
   */
  function model(summary, width, wasCompact) {
    var s = summary;
    if (!s || typeof s !== 'object' || !(s.total > 0 || s.allDone)) return null;
    var counts = s.counts || {};
    var compact = width > 0 && width < (wasCompact ? COMPACT_BELOW + HYSTERESIS : COMPACT_BELOW);
    var segments = [];
    for (var i = 0; i < SEGMENTS.length; i++) {
      var n = +counts[SEGMENTS[i]] || 0;
      if (n > 0) segments.push({ state: SEGMENTS[i], n: n });
    }
    var q = +s.questions || 0;
    var current = null;
    if (s.allDone) current = { state: 'done', text: 'All rows done', dim: true };
    else if (s.current && s.current.title) {
      current = { state: s.current.state, text: (s.current.number ? s.current.number + ' ' : '') + s.current.title, dim: !!s.current.dim };
    }
    var open = Array.isArray(s.open) ? s.open : [];
    var rows = [];
    for (var j = 0; j < open.length && rows.length < MAX_LIST; j++) {
      var r = open[j];
      if (r && r.title) rows.push({ state: r.state, text: (r.number ? r.number + ' ' : '') + r.title, depth: Math.max(1, +r.depth || 1) });
    }
    var left = Math.max(0, (+s.total || 0) - (+s.done || 0));
    var label = 'Work plan: ' + (s.allDone ? 'all rows done' : plural(left, 'row', 'rows') + ' open')
      + (current && !s.allDone ? '; ' + current.text : '') + (q ? '; ' + plural(q, 'question waits', 'questions wait') + ' for your answer' : '');
    return {
      compact: compact,
      segments: segments,
      count: countOf(s),
      current: current,
      questions: q ? (compact ? String(q) : q + ' to decide') : '',
      label: label,
      list: left ? { now: current && !s.allDone ? current.text : '', head: plural(left, 'row', 'rows') + ' not done', rows: rows,
        more: Math.max(0, left - rows.length) } : null
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
  /* `ch` is the width of one figure in the bar's font, so the count's box fits COUNT_ROOM. */
  var countWidth = COUNT_ROOM.length + 'ch';

  /*
   * A bar for document `doc`. `opts.onOpen()` runs on a click on the bar or Enter on it, `opts.onAnswer()` on a click
   * on the questions part; `opts.css` is added to the bar's own style, for a page that wants it closer to its input box.
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
    var shown = null, summary = null, width = 0, compact = false, drawn = '', list = null, timer = 0, hovering = false;
    var win = doc.defaultView || (typeof window === 'object' ? window : null);
    var call = function (fn) { if (typeof fn === 'function') { try { fn(); } catch (e) { /* the page's own handler */ } } };

    function hideList() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (list && list.parentNode) list.parentNode.removeChild(list);
      list = null;
    }
    function showList() {
      timer = 0;
      if (!hovering || !shown || !shown.list || !el.parentNode || !doc.body) return;
      if (list && list.parentNode) list.parentNode.removeChild(list);
      var box = part(doc, 'div', '');
      box.setAttribute(MARK + '-list', '1');
      if (shown.list.now) box.appendChild(part(doc, 'div', 'apb-now', shown.list.now));
      box.appendChild(part(doc, 'div', 'apb-head', shown.list.head));
      for (var i = 0; i < shown.list.rows.length; i++) {
        var r = shown.list.rows[i], li = part(doc, 'div', 'apb-li');
        li.style.paddingLeft = ((r.depth - 1) * 12) + 'px';
        li.appendChild(icon(doc, r.state, COLOR[r.state]));
        li.appendChild(part(doc, 'span', 'apb-text', r.text));
        box.appendChild(li);
      }
      if (shown.list.more) box.appendChild(part(doc, 'div', 'apb-more', 'and ' + shown.list.more + ' more open'));
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
      var key = JSON.stringify(m);
      if (key === drawn) return;
      drawn = key;
      while (el.firstChild) el.removeChild(el.firstChild);
      el.setAttribute('aria-label', m.label);
      el.setAttribute('data-compact', m.compact ? '1' : '0');
      el.appendChild(icon(doc, 'list', ''));
      el.appendChild(part(doc, 'span', 'apb-name', 'Plan'));
      if (!m.compact) {
        var track = part(doc, 'span', 'apb-track');
        for (var i = 0; i < m.segments.length; i++) {
          var seg = part(doc, 'span', 'apb-seg');
          seg.setAttribute('data-state', m.segments[i].state);
          seg.style.flex = m.segments[i].n + ' 1 0px';
          seg.style.background = COLOR[m.segments[i].state];
          track.appendChild(seg);
        }
        el.appendChild(track);
      }
      var count = part(doc, 'span', 'apb-count', m.count);
      count.style.minWidth = countWidth;
      el.appendChild(count);
      if (m.compact) {
        if (m.current && m.current.state === 'done') el.appendChild(icon(doc, 'done', COLOR.done));
        el.appendChild(part(doc, 'span', 'apb-gap'));
      } else if (m.current) {
        var sep = part(doc, 'span', 'apb-sep', String.fromCharCode(183));
        if (!m.count) sep.style.visibility = 'hidden';
        el.appendChild(sep);
        var cur = part(doc, 'span', 'apb-row');
        cur.setAttribute('data-state', m.current.state);
        cur.appendChild(icon(doc, m.current.state, COLOR[m.current.state]));
        cur.appendChild(part(doc, 'span', 'apb-text' + (m.current.dim ? ' apb-dim' : ''), m.current.text));
        el.appendChild(cur);
      } else el.appendChild(part(doc, 'span', 'apb-gap'));
      if (m.questions) {
        var q = part(doc, 'span', 'apb-q');
        q.setAttribute('role', 'button');
        q.setAttribute('tabindex', '0');
        q.setAttribute('aria-label', 'Answer the questions in the plan');
        q.appendChild(part(doc, 'span', 'apb-dot'));
        q.appendChild(part(doc, 'span', '', m.questions));
        q.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); hideList(); call(o.onAnswer); });
        q.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault(); ev.stopPropagation(); call(o.onAnswer);
        });
        el.appendChild(q);
      }
      var chev = icon(doc, 'chevron', '');
      chev.className = 'apb-chev';
      el.appendChild(chev);
      if (list) showList();
    }

    el.addEventListener('click', function (ev) { ev.preventDefault(); hideList(); call(o.onOpen); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault(); call(o.onOpen);
    });
    el.addEventListener('mouseenter', function () {
      hovering = true;
      if (!timer && !list) timer = setTimeout(showList, HOVER_MS);
    });
    el.addEventListener('mouseleave', function () { hovering = false; hideList(); });

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

  return { COMPACT_BELOW: COMPACT_BELOW, HYSTERESIS: HYSTERESIS, TRACK_WIDTH: TRACK_WIDTH, SEGMENT_MIN: SEGMENT_MIN, MAX_LIST: MAX_LIST,
    SEGMENTS: SEGMENTS, COUNT_ROOM: COUNT_ROOM, COLOR: COLOR, ASK: ASK, HOVER_MS: HOVER_MS, MARK: MARK, model: model, create: create };
})();
if (typeof module === 'object' && module) module['exports'] = agentPlusPlanBar;
