// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * shared/page/plan-bar.js, the plan bar Claude Code Plus and Codex Plus draw above their agent's input box, run under
 * Node, where it is also a module, against a stand-in document.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('../fake-vscode');

/* Just enough of a document for the bar: elements with children, attributes, text, style and events that bubble. */
function stand() {
  class Node {
    constructor(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null;
      this.attrs = {}; this.style = { cssText: '', display: '' }; this.className = ''; this.listeners = {}; this._text = ''; this.innerHTML = ''; }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    set textContent(v) { this.childNodes = []; this._text = String(v); }
    get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
    addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
    getBoundingClientRect() { return { left: 20, top: 500, bottom: 526, width: 600, height: 26 }; }
    fire(type, extra = {}) {
      const ev = Object.assign({ type, target: this, stopped: false, prevented: false, stopPropagation() { this.stopped = true; },
        preventDefault() { this.prevented = true; } }, extra);
      for (let n = this; n && !ev.stopped; n = n.parentNode) for (const fn of n.listeners[type] || []) fn(ev);
      return ev;
    }
    all(test, out = []) { for (const c of this.childNodes) { if (test(c)) out.push(c); c.all(test, out); } return out; }
    find(cls) { return this.all((c) => (' ' + c.className + ' ').includes(' ' + cls + ' '))[0] || null; }
  }
  const doc = { createElement: (t) => new Node(t, doc), defaultView: { innerWidth: 1000, innerHeight: 800 } };
  doc.head = new Node('head', doc);
  doc.body = new Node('body', doc);
  return doc;
}

module.exports = async ({ eq, root, wait }) => {
  const file = path.join(root, 'shared', 'page', 'plan-bar.js');
  const text = fs.readFileSync(file, 'utf8');
  eq([/[^\x00-\x7f]/.test(text), /=>|`|\b(let|const|class)\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))], [false, false],
    'the plan bar is ASCII and ES5, as the page scripts it goes into are');
  const bar = require(file);
  {
    const page = vm.createContext({ setTimeout, clearTimeout });
    page.globalThis = page;
    vm.runInContext(text, page);
    eq([typeof page.agentPlusPlanBar.create, page.agentPlusPlanBar.COMPACT_BELOW], ['function', bar.COMPACT_BELOW],
      'in a page it is one global object, agentPlusPlanBar, with the width below which both extensions draw it compact');
  }

  const doing = { total: 12, done: 4, counts: { done: 4, doing: 2, waiting: 0, discussing: 3, todo: 3, parked: 0 }, questions: 2, allDone: false,
    current: { number: '3.2', title: 'CLI: budget subcommand', state: 'doing', dim: false },
    open: [{ number: '3', title: 'CLI', state: 'doing', depth: 1 }, { number: '3.2', title: 'CLI: budget subcommand', state: 'doing', depth: 2 }] };
  const waiting = { total: 12, done: 7, counts: { done: 7, waiting: 1, todo: 4 }, questions: 0, allDone: false,
    current: { number: '3.3.1', title: 'Warnings in report', state: 'waiting', dim: false }, open: [] };
  const parked = { total: 10, done: 9, counts: { done: 9, parked: 1 }, questions: 0, allDone: false,
    current: { number: '10', title: 'Handle refunds later', state: 'parked', dim: true }, open: [{ number: '10', title: 'Handle refunds later', state: 'parked', depth: 1 }] };
  const finished = { total: 12, done: 12, counts: { done: 12 }, questions: 0, allDone: true, current: null, open: [] };
  const wide = bar.COMPACT_BELOW + 200, narrow = bar.COMPACT_BELOW - 1;
  const look = (m) => m && [m.compact, m.segments.map((s) => s.state + ':' + s.n).join(' '), m.count, m.current && [m.current.state, m.current.text, m.current.dim], m.questions];
  eq([look(bar.model(doing, wide)), look(bar.model(waiting, wide)), look(bar.model(parked, wide)), look(bar.model(finished, wide))], [
    [false, 'doing:2 discussing:3 todo:3', '8 open', ['doing', '3.2 CLI: budget subcommand', false], '2 to decide'],
    [false, 'waiting:1 todo:4', '5 open', ['waiting', '3.3.1 Warnings in report', false], ''],
    [false, 'parked:1', '1 open', ['parked', '10 Handle refunds later', true], ''],
    [false, '', '', ['done', 'All rows done', true], ''],
  ], 'each state: the track has the open rows only, in the order doing, waiting, discussing, todo, parked; the count says how many are open; the current row with its state; the questions; with none open, a check and All rows done in grey');
  eq([bar.SEGMENTS, bar.COUNT_ROOM], [['doing', 'waiting', 'discussing', 'todo', 'parked'], '999 open'], 'what the track and the count show is set in one place');
  eq([look(bar.model(doing, narrow)), look(bar.model(doing, bar.COMPACT_BELOW)), look(bar.model(doing, 0))[0]],
    [[true, 'doing:2 discussing:3 todo:3', '8 open', ['doing', '3.2 CLI: budget subcommand', false], '2'], look(bar.model(doing, wide)), false],
    'below the threshold the bar is compact and the red part has only the number; at the threshold, or before the width is known, it is full');
  eq([bar.model(doing, bar.COMPACT_BELOW + bar.HYSTERESIS - 1, true).compact, bar.model(doing, bar.COMPACT_BELOW + bar.HYSTERESIS, true).compact,
    bar.model(doing, bar.COMPACT_BELOW + 1, false).compact, bar.HYSTERESIS > 0],
  [true, false, false, true], 'a compact bar is drawn full again only once it is HYSTERESIS pixels past the threshold, so a width near it does not flip the form');
  eq([bar.model(null, wide), bar.model({ total: 0 }, wide), bar.model('x', wide), look(bar.model({ total: 0, done: 0, counts: {}, allDone: true }, wide))],
    [null, null, null, [false, '', '', ['done', 'All rows done', true], '']],
    'no summary, or one with nothing counted and something not done, draws no bar; one with every row archived or dropped is all done');
  eq([bar.model(doing, wide).list, bar.model(finished, wide).list],
    [{ now: '3.2 CLI: budget subcommand', head: '8 rows not done', rows: [{ state: 'doing', text: '3 CLI', depth: 1 }, { state: 'doing', text: '3.2 CLI: budget subcommand', depth: 2 }], more: 6 }, null],
    'the hover has the current row\'s whole title, then the open rows it was given and how many more are open; a plan with none open has none');
  {
    const many = Object.assign({}, doing, { total: 140, done: 4, open: Array.from({ length: 40 }, (_, i) => ({ number: String(i + 1), title: 'Row ' + (i + 1), state: 'todo', depth: 1 })) });
    const list = bar.model(many, wide).list;
    eq([list.rows.length, bar.MAX_LIST, list.rows[29].text, list.more], [30, 30, '30 Row 30', 106], 'the hover ends at 30 rows and says how many more are open');
  }
  eq(Object.keys(bar.COLOR).map((k) => k + ' ' + bar.COLOR[k].replace(/^var\(--vscode-([\w-]+).*$/, '$1')), [
    'done charts-green', 'doing charts-blue', 'waiting charts-orange', 'discussing charts-yellow', 'todo charts-purple', 'parked descriptionForeground'],
  'the colours are the theme colours of the work plan view\'s state icons');
  {
    const { vscode } = fake.create({});
    const undo = fake.install(vscode);
    fake.fresh(root);
    const look = require(path.join(root, 'src', 'workplan-view.js')).LOOK;
    undo();
    const theirs = Object.keys(bar.COLOR).map((k) => look[k].color.replace('.', '-'));
    eq(theirs, Object.keys(bar.COLOR).map((k) => bar.COLOR[k].replace(/^var\(--vscode-([\w-]+).*$/, '$1')), 'the same as LOOK in src/workplan-view.js says');
  }
  eq(bar.ASK, 'var(--vscode-statusBarItem-warningBackground, #b89500)', 'the questions part is the yellow of the status bar entry that counts the conversations waiting for the user');
  {
    const css = (text.match(/var CSS = ([\s\S]*?);\n/) || [])[1] || '';
    eq([/\.apb-track\{[^}]*flex:none[^}]*width:' \+ TRACK_WIDTH \+ 'px/.test(css), /\.apb-seg\{[^}]*min-width:' \+ SEGMENT_MIN \+ 'px/.test(css),
      bar.TRACK_WIDTH, bar.SEGMENT_MIN, /\.apb-count\{[^}]*flex:none[^}]*font-variant-numeric:tabular-nums/.test(css),
      /\]\{display:flex[^}]*height:26px[^}]*overflow:hidden[^}]*white-space:nowrap/.test(css), /\.apb-text\{[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(css)],
    [true, true, 72, 2, true, true, true],
    'the layout does not change with the plan: a track of one width whose segments are at least 2 px, a count in figures of one width, one line of one height, and a title that ends in an ellipsis');
  }

  const doc = stand();
  const clicks = [];
  const b = bar.create(doc, { onOpen: () => clicks.push('open'), onAnswer: () => clicks.push('answer'), css: 'margin:0 0 8px' });
  doc.body.appendChild(b.el);
  eq([b.el.style.display, doc.head.childNodes.length, b.el.getAttribute('role'), b.el.style.cssText], ['none', 1, 'button', 'margin:0 0 8px'],
    'a new bar is hidden until it has a summary; its style goes into the head once');
  bar.create(doc, {});
  eq(doc.head.childNodes.length, 1, 'a second bar in the same document adds no second style');
  b.fit(wide);
  b.update(doing);
  const q = b.el.find('apb-q');
  const segs = b.el.find('apb-track').childNodes;
  eq([b.el.style.display, segs.map((s) => s.getAttribute('data-state') + ' ' + s.style.flex), b.el.find('apb-count').textContent,
    b.el.find('apb-count').style.minWidth, b.el.find('apb-row').getAttribute('data-state'), b.el.find('apb-row').textContent, q && q.textContent,
    b.el.getAttribute('aria-label')],
  ['', ['doing 2 1 0px', 'discussing 3 1 0px', 'todo 3 1 0px'], '8 open', '8ch', 'doing', '3.2 CLI: budget subcommand', '2 to decide',
    'Work plan: 8 rows open; 3.2 CLI: budget subcommand; 2 questions wait for your answer'],
  'with a summary it shows: the segments, each as long as its share, the count in a box with room for 999 open, the current row, the red part, and a spoken label');
  b.fit(narrow);
  eq([b.el.getAttribute('data-compact'), !!b.el.find('apb-track'), !!b.el.find('apb-row'), b.el.find('apb-count').textContent, b.el.find('apb-q').textContent],
    ['1', false, false, '8 open', '2'], 'narrowed below the threshold it turns compact');
  b.fit(bar.COMPACT_BELOW + 4);
  eq(b.el.getAttribute('data-compact'), '1', 'and stays compact just above the threshold');
  b.fit(wide);
  b.update(parked);
  eq([b.el.getAttribute('data-compact'), b.el.find('apb-text').className, !!b.el.find('apb-q')], ['0', 'apb-text apb-dim', false],
    'widened past the hysteresis it is full again; a parked row is grey, and a plan with no question has no red part');
  b.update(finished);
  eq([b.el.find('apb-count').textContent, b.el.find('apb-track').childNodes.length, b.el.find('apb-row').getAttribute('data-state'), b.el.find('apb-row').textContent],
    ['', 0, 'done', 'All rows done'], 'with nothing open the count is empty but keeps its room, the track is empty, and the check says All rows done');
  eq(b.el.find('apb-sep').style.visibility, 'hidden', 'and the dot after the count keeps its room without showing');

  b.update(doing);
  b.el.fire('click');
  b.el.find('apb-q').fire('click');
  b.el.fire('keydown', { key: 'Enter' });
  b.el.find('apb-q').fire('keydown', { key: 'Enter' });
  b.el.fire('keydown', { key: 'a' });
  eq(clicks, ['open', 'answer', 'open', 'answer'], 'a click or Enter on the bar opens the plan; on the red part it answers, and does not also open the plan');

  b.el.fire('mouseenter');
  eq(doc.body.childNodes.length, 1, 'the list of open rows waits a moment before it shows');
  await wait(bar.HOVER_MS + 50);
  const list = doc.body.childNodes[1];
  eq([list && list.getAttribute(bar.MARK + '-list'), list && list.childNodes.map((c) => c.textContent), list && list.childNodes[3].style.paddingLeft],
    ['1', ['3.2 CLI: budget subcommand', '8 rows not done', '3 CLI', '3.2 CLI: budget subcommand', 'and 6 more open'], '12px'],
    'then it shows the current row\'s whole title and the rows not done, each indented by its depth, and how many more are open');
  eq([list.style.left, list.style.top], ['20px', '468px'], 'placed just above the bar when there is room, at its left edge');
  b.el.fire('mouseleave');
  eq(doc.body.childNodes.length, 1, 'and it goes when the pointer leaves');
  b.el.fire('mouseenter');
  await wait(bar.HOVER_MS + 50);
  b.update(null);
  eq([b.el.style.display, doc.body.childNodes.length], ['none', 1], 'a null summary hides the bar and its list');
  b.destroy();
  eq(doc.body.childNodes.length, 0, 'destroy() takes the bar out of the page');
};
