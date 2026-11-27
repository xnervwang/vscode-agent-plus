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

  const rowsOf = (spec) => spec.map(([number, title, state, depth, asks]) => Object.assign({ number, title, state, depth }, asks ? { asks: true } : {}));
  const busy = { total: 14, done: 4, counts: { done: 4, doing: 2, waiting: 3, discussing: 3, todo: 2, parked: 0 }, asking: { waiting: 1, discussing: 2 },
    questions: 3, allDone: false, current: { number: '3.2', title: 'CLI: budget subcommand', state: 'doing', dim: false },
    open: rowsOf([['3', 'CLI', 'doing', 1], ['3.2', 'CLI: budget subcommand', 'doing', 2], ['4', 'Refunds', 'waiting', 1, true], ['5', 'Report', 'waiting', 1],
      ['6', 'Fonts', 'waiting', 1], ['7', 'Month', 'discussing', 1, true], ['8', 'Names', 'discussing', 1, true], ['9', 'Colours', 'discussing', 1],
      ['10', 'Docs', 'todo', 1], ['11', 'Tests', 'todo', 1]]),
    asks: [{ number: '4', title: 'Refunds', question: 'Skip negative amounts?' }, { number: '7', title: 'Month', question: 'This month or last?' },
      { number: '8', title: 'Names', question: '' }] };
  const parked = { total: 10, done: 9, counts: { done: 9, parked: 1 }, asking: {}, questions: 0, allDone: false, current: null,
    open: rowsOf([['10', 'Handle refunds later', 'parked', 1]]), asks: [] };
  const finished = { total: 12, done: 12, counts: { done: 12 }, asking: {}, questions: 0, allDone: true, current: null, open: [], asks: [] };
  const older = { total: 6, done: 1, counts: { done: 1, doing: 1, waiting: 2, todo: 2 }, questions: 1, allDone: false, current: null, open: [] };
  const wide = bar.COMPACT_BELOW + 200, narrow = bar.COMPACT_BELOW - 1;
  const look = (m) => m && [m.compact, m.bubbles.map((b) => b.state + ':' + b.n).join(' '), m.done, m.questions, m.label];
  eq([look(bar.model(busy, wide)), look(bar.model(parked, wide)), look(bar.model(finished, wide)), look(bar.model(older, wide))], [
    [false, 'doing:2 waiting:2 discussing:1 todo:2', false, '3 to decide', 'Work plan: 2 doing, 2 waiting, 1 discussing, 2 to do; 3 questions wait for your answer'],
    [false, '', false, '', 'Work plan: 1 row open'],
    [false, '', true, '', 'Work plan: all rows done'],
    [false, 'doing:1 waiting:2 todo:2', false, '1 to decide', 'Work plan: 1 doing, 2 waiting, 2 to do; 1 question waits for your answer'],
  ], 'four summaries: a busy plan gets a bubble for each of doing, waiting, discussing and todo in that order, its rows waiting for the answer counted in "to decide" only; a parked one gets none; a finished one is all done; an older one without `asking` counts its asking rows in their states');
  {
    const m = bar.model(busy, wide);
    eq(m.bubbles.reduce((sum, b) => sum + b.n, 0) + busy.questions + busy.counts.parked, busy.total - busy.done,
      'the bubbles and "to decide" add up, with the parked rows, to the rows still open');
  }
  eq([bar.BUBBLES, bar.WORD.todo], [['doing', 'waiting', 'discussing', 'todo'], 'to do'], 'which states get a bubble, and in what order, is set in one place');
  eq([look(bar.model(busy, narrow)).slice(0, 4), look(bar.model(busy, bar.COMPACT_BELOW))[0], look(bar.model(busy, 0))[0]],
    [[true, 'doing:2 waiting:2 discussing:1 todo:2', false, '3'], false, false],
    'below the threshold the bar is compact and "to decide" keeps only its number; at the threshold, or before the width is known, it is full');
  eq([bar.model(busy, bar.COMPACT_BELOW + bar.HYSTERESIS - 1, true).compact, bar.model(busy, bar.COMPACT_BELOW + bar.HYSTERESIS, true).compact,
    bar.model(busy, bar.COMPACT_BELOW + 1, false).compact, bar.HYSTERESIS > 0],
  [true, false, false, true], 'a compact bar is drawn full again only once it is HYSTERESIS pixels past the threshold, so a width near it does not flip the form');
  eq([bar.model(null, wide), bar.model({ total: 0 }, wide), bar.model('x', wide), look(bar.model({ total: 0, done: 0, counts: {}, allDone: true }, wide))],
    [null, null, null, [false, '', true, '', 'Work plan: all rows done']],
    'no summary, or one with nothing counted and something not done, draws no bar; one with every row archived or dropped is all done');
  {
    const l = bar.model(busy, wide).lists;
    eq([Object.keys(l).sort(), l[''].now, l[''].head, l[''].rows.length, l[''].rows[1], l[''].more],
      [['', 'ask', 'discussing', 'doing', 'todo', 'waiting'], '3.2 CLI: budget subcommand', '10 rows not done', 10, { state: 'doing', text: '3.2 CLI: budget subcommand', depth: 2 }, 0],
      'hovering the rest of the bar lists the open rows, under the current row\'s whole title and how many are not done');
    eq([l.waiting, l.discussing.rows.map((r) => r.text)],
      [{ now: '', head: '2 waiting', rows: [{ state: 'waiting', text: '5 Report', depth: 1 }, { state: 'waiting', text: '6 Fonts', depth: 1 }], more: 0 }, ['9 Colours']],
      'hovering a bubble lists the rows of its state, without the ones that wait for the answer');
    eq([l.ask.head, l.ask.rows.map((r) => r.state + ' ' + r.text), l.ask.more], ['3 questions for you', ['question 4 Skip negative amounts?', 'question 7 This month or last?', 'question 8 Names'], 0],
      'hovering "to decide" lists the questions, using the row\'s title for a row that has none');
    eq([bar.model(finished, wide).lists, Object.keys(bar.model(parked, wide).lists)], [{}, ['']], 'a plan with none open has no list; parked rows are in the bar\'s list only');
  }
  {
    const many = Object.assign({}, busy, { total: 140, done: 4, counts: { todo: 136, done: 4 }, asking: {}, questions: 0,
      open: Array.from({ length: 30 }, (_, i) => ({ number: String(i + 1), title: 'Row ' + (i + 1), state: 'todo', depth: 1 })) });
    const l = bar.model(many, wide).lists;
    eq([l[''].rows.length, bar.MAX_LIST, l[''].more, l.todo.rows.length, l.todo.more], [30, 30, 106, 30, 106], 'a list ends at 30 rows and says how many more there are');
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
  {
    const view = fs.readFileSync(path.join(root, 'src', 'workplan-view.js'), 'utf8');
    const asked = (/ThemeIcon\('question', new vscode\.ThemeColor\('([\w.]+)'\)\)/.exec(view) || [])[1] || '';
    eq(bar.ASK.replace(/^var\(--vscode-([\w-]+).*$/, '$1'), asked.replace('.', '-'),
      '"to decide" is filled with the colour the work plan view uses for its question mark');
  }
  {
    const css = (text.match(/var CSS = ([\s\S]*?);\n/) || [])[1] || '';
    eq([/\]\{display:flex[^}]*height:26px[^}]*overflow:hidden[^}]*white-space:nowrap[^}]*--apb-tint:' \+ TINT\.dark \+ '%/.test(css),
      /body\.vscode-light \[' \+ MARK \+ '\],body\.vscode-high-contrast-light \[' \+ MARK \+ '\]\{--apb-tint:' \+ TINT\.light \+ '%\}/.test(css), bar.TINT.light > bar.TINT.dark,
      /\.apb-q\{' \+ pill \+ '[^}]*color:' \+ ASK_TEXT \+ ';background:' \+ ASK \+ '\}/.test(css), /body\.vscode-high-contrast \.apb-q,body\.vscode-high-contrast-light \.apb-q\{color:#fff\}/.test(css)],
    [true, true, true, true, true],
    'one line of one height; bubbles tinted more in light themes; "to decide" a solid fill with dark text, or white text in the high contrast themes');
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
  b.update(busy);
  const bubbles = () => b.el.all((c) => c.className === 'apb-b');
  eq([b.el.style.display, !!b.el.find('apb-name'), bubbles().map((x) => x.getAttribute('data-state') + ' ' + x.textContent),
    bubbles()[0].style.background, b.el.find('apb-q').textContent, !!b.el.find('apb-chev'), b.el.getAttribute('aria-label')],
  ['', true, ['doing 2', 'waiting 2', 'discussing 1', 'todo 2'], 'color-mix(in srgb, ' + bar.COLOR.doing + ' var(--apb-tint), transparent)', '3 to decide', true,
    'Work plan: 2 doing, 2 waiting, 1 discussing, 2 to do; 3 questions wait for your answer'],
  'with a summary it shows Plan, a bubble for each state with rows, tinted with its colour, "to decide", the arrow and a spoken label');
  b.fit(narrow);
  eq([b.el.getAttribute('data-compact'), !!b.el.find('apb-name'), bubbles().length, b.el.find('apb-q').textContent, !!b.el.find('apb-chev')],
    ['1', false, 4, '3', false], 'narrowed below the threshold it drops Plan and the arrow, keeps the bubbles, and "to decide" shows just the number');
  b.fit(bar.COMPACT_BELOW + 4);
  eq(b.el.getAttribute('data-compact'), '1', 'and stays compact just above the threshold');
  b.fit(wide);
  b.update(parked);
  eq([b.el.getAttribute('data-compact'), bubbles().length, !!b.el.find('apb-q')], ['0', 0, false], 'widened past the hysteresis it is full again; parked rows alone draw no bubble, and no question no "to decide"');
  b.update(finished);
  eq([b.el.find('apb-text').textContent, b.el.find('apb-text').className], ['All rows done', 'apb-text apb-dim'], 'with nothing open a check says All rows done');

  b.update(busy);
  b.el.fire('click');
  bubbles()[1].fire('click');
  b.el.find('apb-q').fire('click');
  b.el.fire('keydown', { key: 'Enter' });
  b.el.find('apb-q').fire('keydown', { key: 'Enter' });
  b.el.fire('keydown', { key: 'a' });
  eq(clicks, ['open', 'open', 'answer', 'open', 'answer'], 'a click or Enter on the bar or a bubble opens the plan; on "to decide" it answers, and does not also open the plan');

  const texts = () => (doc.body.childNodes[1] ? doc.body.childNodes[1].childNodes.map((c) => c.textContent) : null);
  b.el.fire('mouseover');
  eq(doc.body.childNodes.length, 1, 'a list waits a moment before it shows');
  await wait(bar.HOVER_MS + 50);
  const list = doc.body.childNodes[1];
  eq([list && list.getAttribute(bar.MARK + '-list'), texts().slice(0, 4), list && list.childNodes[3].style.paddingLeft, list.style.left, list.style.top],
    ['1', ['3.2 CLI: budget subcommand', '10 rows not done', '3 CLI', '3.2 CLI: budget subcommand'], '12px', '20px', '468px'],
    'the drawn list has the current row\'s title, the count of rows not done and the open rows, a child row indented 12 px, and sits just above the bar at its left edge');
  bubbles()[1].fire('mouseover');
  eq(texts(), ['2 waiting', '5 Report', '6 Fonts'], 'moved onto a bubble while a list shows, the list switches at once to that state\'s rows');
  b.el.find('apb-q').childNodes[1].fire('mouseover');
  eq(texts(), ['3 questions for you', '4 Skip negative amounts?', '7 This month or last?', '8 Names'], 'and moved onto "to decide", to the questions');
  b.el.fire('mouseleave');
  eq(doc.body.childNodes.length, 1, 'and it goes when the pointer leaves');
  b.el.fire('mouseover');
  await wait(bar.HOVER_MS + 50);
  b.update(null);
  eq([b.el.style.display, doc.body.childNodes.length], ['none', 1], 'a null summary hides the bar and its list');
  b.destroy();
  eq(doc.body.childNodes.length, 0, 'destroy() takes the bar out of the page');
};
