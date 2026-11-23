// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/page/kit.js; sync-shared.js copies it, so edit it there.

/*
 * Helpers shared by the Claude Code Plus and Codex Plus page scripts, exported as a single object, agentPlusKit, so
 * that its names cannot collide with names already in either page. Claude Code Plus adds this file to its page script
 * as a fragment; Codex Plus puts it in front of its page script, and each patch's marker is a digest of the combined
 * script. Under Node it is also a module, for the session list Codex Plus draws in the extension host. The source is
 * ASCII and ES5, like the page scripts.
 */
var agentPlusKit = (function () {
  'use strict';
  var ARROW = String.fromCharCode(8594);
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };

  /* HH:MM:SS, or HH:MM without seconds. A day other than today goes in front as MM/DD, with the year when it is not
     this one: month before day everywhere, so 01/10 never reads as two different days. */
  function stamp(ms, secs) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var d = new Date(ms), now = new Date();
    var t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + (secs === false ? '' : ':' + p2(d.getSeconds()));
    if (d.toDateString() === now.toDateString()) return t;
    var md = p2(d.getMonth() + 1) + '/' + p2(d.getDate());
    return (d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '/' + md) + ' ' + t;
  }

  /* How long ago, as Claude Code's own session list writes it: now, then whole minutes, hours, days, months of 30 days
     and years. */
  function age(ms, now) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    var s = Math.max(0, Math.floor(((now == null ? Date.now() : now) - ms) / 1000));
    var m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24), mo = Math.floor(d / 30), y = Math.floor(d / 365);
    return y > 0 ? y + 'y' : mo > 0 ? mo + 'mo' : d > 0 ? d + 'd' : h > 0 ? h + 'h' : m > 0 ? m + 'm' : 'now';
  }

  /* The days a conversation spans, from its first message to its last, or one day when both are the same: 11/05->11/09.
     A year other than the current one is written once, in front, for a span within that year. */
  function span(firstMs, lastMs, now) {
    if (typeof lastMs !== 'number' || !isFinite(lastMs) || !lastMs) return '';
    var year = new Date(now == null ? Date.now() : now).getFullYear();
    var ymd = function (ms) { var t = new Date(ms); return { y: t.getFullYear(), md: p2(t.getMonth() + 1) + '/' + p2(t.getDate()) }; };
    var one = function (v) { return v.y === year ? v.md : v.y + '/' + v.md; };
    var e = ymd(lastMs), s = typeof firstMs === 'number' && isFinite(firstMs) && firstMs ? ymd(firstMs) : null;
    if (!s || (s.y === e.y && s.md === e.md)) return one(e);
    return s.y === e.y && s.y !== year ? s.y + '/' + s.md + ARROW + e.md : one(s) + ARROW + one(e);
  }

  function kfmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function pct(n, of) {
    if (!(of > 0)) return '';
    var v = 100 * n / of;
    return v < 0.1 && v > 0 ? '<0.1%' : v.toFixed(1) + '%';
  }

  /* Each chime has its own pattern: rising for a finished turn, three equal notes when the agent waits for a
     permission, falling for a question. Each step is [Hz, start in s, length in s]. */
  var TONES = {
    done: [[880, 0, 0.09], [1174, 0.09, 0.16]],
    permission: [[880, 0, 0.07], [880, 0.13, 0.07], [880, 0.26, 0.11]],
    question: [[1174, 0, 0.09], [880, 0.10, 0.16]],
  };
  TONES.approval = TONES.permission;
  var GAIN = 0.05, RESUME_WAIT_MS = 300;
  var audio = null;
  function audioCtx() {
    var Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    if (!audio || audio.state === 'closed') { try { audio = new Ctor(); } catch (e) { audio = null; } }
    return audio;
  }
  /* A context made before anyone has clicked or typed in the page starts suspended under the browser's autoplay rule.
     The page calls this from its first click or key. */
  function unlockAudio() {
    var ac = audioCtx();
    if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') { try { ac.resume(); } catch (e) { /* refused */ } }
  }
  /* Plays `kind` and calls tell(kind, state) with the context's state, 'unavailable' when there is none. A suspended
     context is resumed first; a refused resume() never settles, so the chime is dropped after RESUME_WAIT_MS rather
     than sounding at some later click. */
  function chime(kind, tell) {
    var say = typeof tell === 'function' ? tell : function () {};
    var ac = audioCtx();
    if (!ac) { say(kind, 'unavailable'); return; }
    var play = function () {
      try {
        var steps = TONES[kind] || TONES.done, t0 = ac.currentTime + 0.01;
        for (var i = 0; i < steps.length; i++) {
          var at = t0 + steps[i][1], dur = steps[i][2];
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(steps[i][0], at);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(GAIN, at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          o.connect(g); g.connect(ac.destination);
          o.start(at); o.stop(at + dur + 0.02);
        }
      } catch (e) { /* no audio here */ }
      say(kind, ac.state);
    };
    if (ac.state !== 'suspended' || typeof ac.resume !== 'function') { play(); return; }
    var settled = false;
    var go = function () {
      if (settled) return;
      settled = true;
      if (ac.state === 'running') play(); else say(kind, ac.state);
    };
    try { Promise.resolve(ac.resume()).then(go, go); } catch (e) { go(); }
    setTimeout(go, RESUME_WAIT_MS);
  }

  /*
   * A hover label drawn by the page, since neither panel shows a native title. `opts.mark` is [attribute, value] put on
   * the box, `opts.css` its look. The box is placed after it is in the document, because its height depends on how the
   * text wrapped: centred over the control and kept 8px inside the window, above it when there is room and below
   * otherwise. It is removed on leave and on click, since a label left over a control after it is clicked looks stuck.
   */
  function labels(opts) {
    var box = null;
    var rect = function (el) { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
    function hide() { if (box) { try { box.parentNode && box.parentNode.removeChild(box); } catch (e) { /* gone */ } box = null; } }
    function show(el, text) {
      var said = typeof text === 'string' && text ? text : el && el.getAttribute && el.getAttribute('aria-label');
      if (!said || !document.body) return;
      hide();
      var b = document.createElement('div');
      if (opts.mark) b.setAttribute(opts.mark[0], opts.mark[1]);
      b.style.cssText = 'position:fixed;pointer-events:none;max-width:260px;line-height:1.35;white-space:pre-line;overflow-wrap:anywhere;'
        + (opts.css || '');
      b.textContent = said;
      document.body.appendChild(b);
      var r = rect(el), s = rect(b);
      if (r && s) {
        var vw = +globalThis.innerWidth || 0, w = s.width || 0, h = s.height || 0;
        var top = r.top || 0, bottom = r.bottom != null ? r.bottom : top + (r.height || 0);
        var left = (r.left || 0) + (r.width || 0) / 2 - w / 2;
        b.style.left = Math.round(Math.max(8, vw ? Math.min(vw - w - 8, left) : left)) + 'px';
        b.style.top = Math.round(top - h - 8 >= 8 ? top - h - 8 : bottom + 8) + 'px';
      }
      box = b;
    }
    /* Gives `el` its label text and, once, the listeners; `wired` is the attribute that says it has them. */
    function wire(el, text, wired) {
      if (!el) return;
      if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-label', text);
      if (el.getAttribute(wired) !== null) return;
      el.setAttribute(wired, '1');
      el.addEventListener('mouseenter', function () { show(el); });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('click', hide);
    }
    return { show: show, hide: hide, wire: wire, current: function () { return box; } };
  }

  /*
   * Other conversations named in an agent's reply. mentionIndex() is built from the conversations the page knows of,
   * once each time that list changes; mentions() finds them in one string; linkMentions() and linkMentionsTree() put
   * the element make() returns in place of each, in a DOM subtree or in a HAST tree (the tree react-markdown renders).
   *
   * A conversation is named by its title inside the corner brackets U+300C and U+300D, by its title standing on its
   * own, by its whole session id, or by the first 8 characters of that id when no other conversation's id starts with
   * them. Titles are compared as they are shown, without the marks the extensions draw with them (src/title-marks.js).
   * The minimum lengths keep short titles from matching common words: a title in brackets needs 4 characters or 2 CJK
   * characters, and one standing on its own a width of 10, a CJK character counting 2, and no letter or digit touching
   * either end. An id that is part of a path, next to a slash or followed by a file extension, names a folder or a
   * file rather than the conversation, and is left alone. Where two matches overlap the longer one is kept. Of several
   * conversations with one title the most recently active is linked and the others are listed with it. The
   * conversation the text belongs to is never linked, nor any other with its title.
   */
  var LQ = '\u300C', RQ = '\u300D';
  var MARKS = /(?:\uD83D\uDC51|\uD83D\uDECE|\u2709)[\uFE0E\uFE0F]?/g;
  var PLACEHOLDERS = { '(untitled)': 1, 'untitled': 1, 'new chat': 1, 'new session': 1, 'new conversation': 1 };
  var UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  var SHORT = /[0-9a-fA-F]{8}/g;
  var ID_CHAR = /[0-9A-Za-z_\-\/\\]/;
  var EXTENSION = /^\.[0-9A-Za-z*]/;
  /* The letters and digits an unbracketed title may not touch. CJK text is written without spaces, so a CJK character
     next to the title does not stop it. */
  var WORD_CHAR = /[0-9A-Za-z_\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
  var CJK = /^(?:[\u3041-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]|[\uD840-\uD87F][\uDC00-\uDFFF])$/;
  var WIDE = /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]$/;
  var QUOTED_MIN = 4, QUOTED_MIN_CJK = 2, BARE_MIN_WIDTH = 10;
  var MARK_ATTR = 'data-agent-plus-mention', MARK_PROP = 'dataAgentPlusMention';
  var SKIP = { pre: 1, a: 1, input: 1, textarea: 1, select: 1, button: 1, script: 1, style: 1 };
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  /* `title` without the crown, envelope or bell, as withoutMarks() in src/title-marks.js. */
  function withoutMarks(title) {
    var s = String(title == null ? '' : title);
    MARKS.lastIndex = 0;
    if (!MARKS.test(s)) return s;
    MARKS.lastIndex = 0;
    var parts = s.split(MARKS), kept = [];
    for (var i = 0; i < parts.length; i++) { var p = parts[i].trim(); if (p) kept.push(p); }
    return kept.join(' ').replace(/\s{2,}/g, ' ');
  }
  var titleKey = function (t) { return withoutMarks(t).replace(/\s+/g, ' ').trim(); };

  /* Its characters, a surrogate pair counting once; how many of them are CJK; and its width, a wide one counting 2. */
  function measure(s) {
    var out = { chars: 0, cjk: 0, width: 0 };
    for (var i = 0; i < s.length; i++) {
      var hi = s.charCodeAt(i), pair = hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s.length;
      var ch = pair ? s.substr(i, 2) : s.charAt(i);
      if (pair) i++;
      out.chars++;
      if (CJK.test(ch)) out.cjk++;
      out.width += pair || WIDE.test(ch) ? 2 : 1;
    }
    return out;
  }

  /*
   * `known` is [{ sourceId, sessionId, title, lastActiveAt, label, cwd }], `label` naming the agent. `self` is the
   * { sourceId, sessionId, title } of the conversation the text belongs to.
   */
  function mentionIndex(known, self) {
    var me = self || {}, list = Array.isArray(known) ? known : [];
    var ix = { ids: Object.create(null), short: Object.create(null), quoted: Object.create(null), bare: Object.create(null),
      self: typeof me.sessionId === 'string' ? me.sessionId.toLowerCase() : '', size: 0 };
    var groups = Object.create(null), prefixes = Object.create(null), selfTitle = me.title ? titleKey(me.title) : '';
    var isSelf = function (c) { return !!ix.self && c.sessionId.toLowerCase() === ix.self && (!me.sourceId || c.sourceId === me.sourceId); };
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId) continue;
      var c = { sourceId: String(raw.sourceId || ''), sessionId: raw.sessionId, title: titleKey(raw.title), label: String(raw.label || ''),
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '', lastActiveAt: +raw.lastActiveAt || 0 };
      var id = c.sessionId.toLowerCase(), head = id.slice(0, 8);
      if (/^[0-9a-f]{8}(?:-|$)/.test(id)) prefixes[head] = own(prefixes, head) ? null : c;
      if (isSelf(c)) { if (!selfTitle) selfTitle = c.title; continue; }
      ix.ids[id] = c;
      ix.size++;
      if (!c.title || own(PLACEHOLDERS, c.title.toLowerCase()) || /^[0-9a-f]{8}(?:-[0-9a-f-]*)?$/i.test(c.title)) continue;
      if (!own(groups, c.title)) groups[c.title] = [];
      groups[c.title].push(c);
    }
    for (var p in prefixes) if (prefixes[p] && !isSelf(prefixes[p])) ix.short[p] = prefixes[p];
    for (var t in groups) {
      if (t === selfTitle) continue;
      var g = groups[t].slice().sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
      var m = measure(t), entry = { title: t, best: g[0], others: g.slice(1) };
      if (m.chars >= QUOTED_MIN || m.cjk >= QUOTED_MIN_CJK) ix.quoted[t] = entry;
      if (m.width >= BARE_MIN_WIDTH) {
        var first = t.charAt(0);
        if (!own(ix.bare, first)) ix.bare[first] = [];
        ix.bare[first].push(entry);
      }
    }
    for (var f in ix.bare) ix.bare[f].sort(function (a, b) { return b.title.length - a.title.length; });
    return ix;
  }

  var apart = function (s, i, re) { return i < 0 || i >= s.length || !re.test(s.charAt(i)); };
  var idApart = function (s, start, end) { return apart(s, start - 1, ID_CHAR) && apart(s, end, ID_CHAR) && !EXTENSION.test(s.substr(end, 2)); };
  var conv =function (c) { return { sourceId: c.sourceId, sessionId: c.sessionId, title: c.title, label: c.label, cwd: c.cwd, lastActiveAt: c.lastActiveAt }; };

  /*
   * The non-overlapping ranges of `text` that name a conversation in `ix`, in order: { start, end, kind, sourceId,
   * sessionId, title, label, cwd, lastActiveAt, others }, `kind` being 'id', 'short', 'quoted' or 'title' and `others`
   * the conversations with the same title. With `opts.idsOnly` only ids are looked for, as in inline code.
   */
  function mentions(text, ix, opts) {
    var s = typeof text === 'string' ? text : '', o = opts || {}, found = [], m, c;
    if (!s || !ix || !ix.size) return [];
    var add = function (start, end, kind, who, others) { found.push({ start: start, end: end, kind: kind, c: who, others: others || [] }); };
    UUID.lastIndex = 0;
    while ((m = UUID.exec(s))) {
      c = ix.ids[m[0].toLowerCase()];
      if (c && idApart(s, m.index, m.index + m[0].length)) add(m.index, m.index + m[0].length, 'id', c);
    }
    SHORT.lastIndex = 0;
    while ((m = SHORT.exec(s))) {
      c = ix.short[m[0].toLowerCase()];
      if (c && idApart(s, m.index, m.index + 8)) add(m.index, m.index + 8, 'short', c);
    }
    if (!o.idsOnly) {
      var at = s.indexOf(LQ);
      while (at >= 0) {
        var close = s.indexOf(RQ, at + 1), next = s.indexOf(LQ, at + 1);
        if (close < 0) break;
        if (next >= 0 && next < close) { at = next; continue; }
        var inner = s.slice(at + 1, close), lead = inner.length - inner.replace(/^\s+/, '').length;
        var key = titleKey(inner), e = key && own(ix.quoted, key) ? ix.quoted[key] : null;
        if (e) add(at + 1 + lead, at + 1 + lead + inner.trim().length, 'quoted', e.best, e.others);
        at = s.indexOf(LQ, close + 1);
      }
      for (var i = 0; i < s.length; i++) {
        var list = own(ix.bare, s.charAt(i)) ? ix.bare[s.charAt(i)] : null;
        for (var j = 0; list && j < list.length; j++) {
          var t = list[j].title;
          if (s.substr(i, t.length) === t && apart(s, i - 1, WORD_CHAR) && apart(s, i + t.length, WORD_CHAR)) {
            add(i, i + t.length, 'title', list[j].best, list[j].others);
          }
        }
      }
    }
    found.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start) || a.start - b.start; });
    var kept = [];
    for (var k = 0; k < found.length; k++) {
      var clash = false;
      for (var q = 0; q < kept.length && !clash; q++) clash = found[k].start < kept[q].end && kept[q].start < found[k].end;
      if (!clash) kept.push(found[k]);
    }
    kept.sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var r = 0; r < kept.length; r++) {
      var x = conv(kept[r].c), others = [];
      for (var y = 0; y < kept[r].others.length; y++) others.push(conv(kept[r].others[y]));
      x.start = kept[r].start; x.end = kept[r].end; x.kind = kept[r].kind; x.others = others;
      out.push(x);
    }
    return out;
  }

  /* The hover label of a link made from range `r`: the conversation, its agent and when it was last active, and the
     other conversations with the same title. */
  function mentionTip(r, now) {
    if (!r) return '';
    var ago = function (ms) { var a = age(ms, now); return a === 'now' ? 'now' : a + ' ago'; };
    var lines = [r.title || r.sessionId, (r.label ? r.label + ' conversation' : 'Conversation') + ' ' + r.sessionId.slice(0, 8)
      + (r.lastActiveAt ? ', active ' + ago(r.lastActiveAt) : '')];
    var others = r.others || [];
    if (others.length) {
      var named = [];
      for (var i = 0; i < others.length && i < 3; i++) {
        var o = others[i];
        named.push((o.label ? o.label + ' ' : '') + o.sessionId.slice(0, 8) + (o.lastActiveAt ? ', active ' + ago(o.lastActiveAt) : ''));
      }
      lines.push((others.length === 1 ? 'Another conversation has' : others.length + ' other conversations have') + ' this title: '
        + named.join('; ') + (others.length > 3 ? '; and ' + (others.length - 3) + ' more' : ''));
    }
    return lines.join('\n');
  }

  var domTree = {
    kids: function (n) { var k = n.childNodes, out = []; for (var i = 0; k && i < k.length; i++) out.push(k[i]); return out; },
    text: function (n) { return n.nodeType === 3 ? String(n.nodeValue || '') : null; },
    tag: function (n) { return n.nodeType === 1 ? String(n.nodeName || '').toLowerCase() : ''; },
    closed: function (n) {
      if (!n.getAttribute) return false;
      var ce = n.getAttribute('contenteditable');
      return n.getAttribute(MARK_ATTR) !== null || n.isContentEditable === true || (ce !== null && ce !== 'false');
    },
    within: function (n) {
      var a = n && n.parentNode && n.parentNode.closest ? n.parentNode.closest('pre,a,input,textarea,select,button,[' + MARK_ATTR + '],[contenteditable]:not([contenteditable="false"])') : null;
      if (a) return 'skip';
      return n && n.parentNode && n.parentNode.closest && n.parentNode.closest('code') ? 'code' : '';
    },
    mark: function (el, r) { el.setAttribute(MARK_ATTR, r.sourceId + ':' + r.sessionId); },
    replace: function (parent, node, parts) {
      var doc = node.ownerDocument;
      for (var i = 0; i < parts.length; i++) parent.insertBefore(typeof parts[i] === 'string' ? doc.createTextNode(parts[i]) : parts[i], node);
      parent.removeChild(node);
    },
  };
  var hastTree = {
    kids: function (n) { return n && n.children ? n.children.slice() : []; },
    text: function (n) { return n && n.type === 'text' ? String(n.value || '') : null; },
    tag: function (n) { return n && n.type === 'element' ? String(n.tagName || '').toLowerCase() : ''; },
    closed: function (n) {
      var p = n.properties || {};
      return p[MARK_PROP] != null || (p.contentEditable != null && String(p.contentEditable) !== 'false');
    },
    within: function () { return ''; },
    mark: function (el, r) { el.properties = el.properties || {}; el.properties[MARK_PROP] = r.sourceId + ':' + r.sessionId; },
    replace: function (parent, node, parts) {
      var at = parent.children.indexOf(node), put = [];
      for (var i = 0; i < parts.length; i++) put.push(typeof parts[i] === 'string' ? { type: 'text', value: parts[i] } : parts[i]);
      if (at >= 0) parent.children.splice.apply(parent.children, [at, 1].concat(put));
    },
  };

  /* Skips code blocks (pre), links, form fields, editable text and what it made itself, so it can run again over the
     same nodes. In inline code only ids are linked. Returns how many links it made. */
  function linkWith(tree, root, ix, make) {
    if (!root || !ix || !ix.size || typeof make !== 'function') return 0;
    var made = 0;
    var visit = function (node, idsOnly) {
      var kids = tree.kids(node);
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i], s = tree.text(k);
        if (s === null) {
          var tag = tree.tag(k);
          if (tag && !own(SKIP, tag) && !tree.closed(k)) visit(k, idsOnly || tag === 'code');
          continue;
        }
        var ranges = s ? mentions(s, ix, { idsOnly: idsOnly }) : [], parts = [], from = 0;
        for (var j = 0; j < ranges.length; j++) {
          var el = make(ranges[j], s.slice(ranges[j].start, ranges[j].end));
          if (!el) continue;
          tree.mark(el, ranges[j]);
          if (ranges[j].start > from) parts.push(s.slice(from, ranges[j].start));
          parts.push(el);
          from = ranges[j].end;
          made++;
        }
        if (!parts.length) continue;
        if (from < s.length) parts.push(s.slice(from));
        tree.replace(node, k, parts);
      }
    };
    var top = tree.tag(root), where = tree.within(root);
    if (where === 'skip' || (top && (own(SKIP, top) || tree.closed(root)))) return 0;
    visit(root, top === 'code' || where === 'code');
    return made;
  }
  function linkMentions(root, ix, make) { return linkWith(domTree, root, ix, make); }
  function linkMentionsTree(root, ix, make) { return linkWith(hastTree, root, ix, make); }

  return { p2: p2, stamp: stamp, age: age, span: span, kfmt: kfmt, pct: pct, TONES: TONES, chime: chime, unlockAudio: unlockAudio,
    labels: labels, withoutMarks: withoutMarks, mentionIndex: mentionIndex, mentions: mentions, mentionTip: mentionTip,
    linkMentions: linkMentions, linkMentionsTree: linkMentionsTree, MENTION_ATTR: MARK_ATTR };
})();
if (typeof module === 'object' && module) module['exports'] = agentPlusKit;
