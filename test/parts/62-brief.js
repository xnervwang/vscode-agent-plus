// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How a conversation's brief is read from its plan and shown in the Answer view, and how its row and page lead back
 * to the conversation.
 */
const fs = require('fs');
const path = require('path');
const { boot } = require('../boot');
const fake = require('../fake-vscode');

const T = 'cdcdcdcd-1111-4222-8333-444444444444';
const MIN = 60e3;

/* An Answer view with a stand-in webview, recording what it posts. */
function answerView(root, lang = 'en') {
  const { AnswerView } = require(path.join(root, 'src', 'answer-view.js'));
  const { ageSince } = require(path.join(root, 'src', 'workplan-view.js'));
  const posted = [], opened = [];
  let receive = null;
  const v = new AnswerView({ send() {}, open: (t) => opened.push(t), age: (ms) => ageSince(ms), clock: () => '10:00' });
  v.setLanguage(lang);
  v.resolveWebviewView({ webview: { options: {}, html: '', postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => { receive = fn; } },
    onDidDispose() {} });
  return { v, posted, opened, last: () => posted[posted.length - 1], send: (m) => receive(m) };
}

/*
 * Runs the Answer view's page script against a minimal stand-in document. `post` delivers a message from the host;
 * `sent` collects the page's messages.
 */
function runPage(html) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const make = (tag) => ({
    tag, children: [], style: {}, className: '', attrs: {}, listeners: {}, value: '', disabled: false, open: false, own: '',
    get textContent() { return this.own + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this.own = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    focus() {},
  });
  const els = {};
  for (const m of html.matchAll(/id="([\w-]+)"/g)) els[m[1]] = make('div');
  const document = { getElementById: (id) => els[id], createElement: make,
    createTextNode: (t) => Object.assign(make('#text'), { own: String(t) }) };
  const heard = [], sent = [];
  const window = { addEventListener: (type, fn) => heard.push(fn) };
  new Function('acquireVsCodeApi', 'document', 'window', 'Intl', script)(() => ({ postMessage: (m) => sent.push(m) }), document, window, Intl);
  const fire = (el, type) => (el.listeners[type] || []).forEach((fn) => fn({ preventDefault() {} }));
  return { els, sent, post: (data) => heard.forEach((fn) => fn({ data })), fire };
}

module.exports = async ({ eq, tmp, root, wait }) => {
  const { readPlanAt } = require(path.join(root, 'src', 'workplan.js'));
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  /* ── Reading it ── */
  {
    const dir = tmp('brief-read');
    const read = (brief) => {
      const f = path.join(dir, T + '.json');
      fs.writeFileSync(f, JSON.stringify({ nodes: [{ title: 'A', state: 'todo' }], brief }));
      return readPlanAt(f, T).brief;
    };
    const full = read({ summary: ' For the brief. ', summaryAt: iso(now - 60 * MIN), status: { doing: 'Tests', progress: 'Red', next: 'none' },
      statusAt: iso(now - 5 * MIN) });
    eq([full.summary, full.summaryAt, full.status, full.statusAt],
      ['For the brief.', Date.parse(iso(now - 60 * MIN)), { doing: 'Tests', progress: 'Red', next: 'none' }, Date.parse(iso(now - 5 * MIN))],
      'the plan\'s brief is read with its times');
    eq([read(undefined), read('text'), read([1]), read({ summary: 3, status: 'x' }), read({ status: { doing: 4 } }),
      read({ summary: 'only' }).status], [null, null, null, null, null, null],
    'a brief that is missing or of the wrong type reads as none, and a part of the wrong type as not written');
  }

  /* ── The page ── */
  const undo = fake.install(fake.create().vscode);
  fake.fresh(root);
  const conv = require(path.join(root, 'src', 'conversations-view.js'));
  const { STALE_MS } = require(path.join(root, 'src', 'brief.js'));
  const C = (over) => Object.assign({ sourceId: 'codex', sessionId: T, title: 'Ship the brief', cwd: '/w', running: true, state: 'idle',
    since: now - 2 * MIN, hasPlan: true, brief: null, doing: [], questions: [],
    top: [{ row: '1', title: 'Old', state: 'done', open: false }, { row: '2', title: 'Brief view', state: 'doing', open: true }] }, over);
  const written = { summary: 'Adds the brief to the Conversations panel.', summaryAt: now - 120 * MIN,
    status: { doing: 'Writing tests', progress: 'Shared hooks pass', next: 'Commit' }, statusAt: now - 10 * MIN };
  {
    const a = answerView(root);
    a.v.showBrief(conv.briefOf(C({ brief: Object.assign({}, written, { statusAt: now - 2 * MIN }) })));
    const p = a.last();
    const [summary, status] = p.sections;
    eq([p.type, p.title, summary.lines[0].text, summary.when, summary.auto, status.lines.map((l) => [l.label, l.text]), status.when,
      status.stale, status.auto],
    ['brief', 'Ship the brief', 'Adds the brief to the Conversations panel.', 'written 2h ago', false,
      [['Doing', 'Writing tests'], ['Latest', 'Shared hooks pass'], ['Next', 'Commit']], 'written 2m ago', '', false],
    'the page shows the summary and the three parts of the status, each with how long ago it was written');
    a.v.showBrief(conv.briefOf(C({ brief: written, since: written.statusAt + STALE_MS + MIN })));
    const staleNow = a.last().sections[1].stale;
    a.v.showBrief(conv.briefOf(C({ brief: written, since: written.statusAt + STALE_MS - MIN })));
    eq([/out of date/.test(staleNow), a.last().sections[1].stale], [true, ''],
      'the status is marked as possibly out of date once the conversation was active more than five minutes after it');
  }
  {
    const a = answerView(root);
    const q = { row: '3', title: 'Pick', question: 'Merge now?', since: now - 4 * MIN, state: 'waiting', note: '', detail: '' };
    a.v.showBrief(conv.briefOf(C({ state: 'working', doing: [{ row: '2', title: 'Brief view', since: now - 12 * MIN, note: 'page half done' }],
      questions: [q] })));
    const p = a.last();
    const [summary, status] = p.sections;
    eq([summary.auto, summary.lines.map((l) => l.label + ' ' + l.text), status.auto, status.lines.map((l) => [l.label, l.text]),
      p.auto, p.live, p.questionsHead, p.questions],
    [true, ['2. Brief view (doing)', '1. Old (done)'], true, [['Doing', '2. Brief view \u00b7 page half done'], ['Last active', '2m ago']],
      'Put together from the work plan, not written by the conversation.', 'Now: working \u00b7 2. Brief view (doing for 12m)',
      'Waiting for your answer', [{ row: '3', text: '3. Merge now?', when: 'asked 4m ago' }]],
    'with no brief, the page is put together from the top rows, the doing rows with their notes and the last activity, and says so');
    a.send({ type: 'ask', key: p.key, row: '3' });
    const asked = a.last();
    a.v.showBrief(conv.briefOf(C({ brief: written })));
    a.send({ type: 'open', key: a.last().key });
    eq([asked.type, asked.question, a.opened], ['show', 'Merge now?', [{ sourceId: 'codex', sessionId: T, cwd: '/w', title: 'Ship the brief' }]],
      'a question on the page opens it to be answered, and the page\'s button goes to the conversation');
    const z = answerView(root, 'zh-cn');
    z.v.showBrief(conv.briefOf(C({})));
    eq([z.last().auto, z.last().sections.map((s) => s.head)], ['\u8fd9\u662f\u81ea\u52a8\u62fc\u7684\uff0c\u4e0d\u662f\u5bf9\u8bdd\u81ea\u5df1\u5199\u7684\u3002',
      ['\u603b\u7ed3', '\u5f53\u524d\u72b6\u6001']], 'in Chinese the put-together page says so in Chinese');
    const before = a.posted.length;
    a.v.reviseBrief(() => conv.briefOf(C({ brief: written })));
    const same = a.posted.length - before;
    a.v.reviseBrief(() => null);
    eq([same, !!a.last().gone], [0, true], 'a pass that changes nothing posts nothing, and a conversation gone from the list says so');
  }
  {
    const a = answerView(root);
    const q = { row: '3', title: 'Pick', question: 'Merge now?', since: now - 4 * MIN, state: 'waiting', note: '', detail: '' };
    a.v.showBrief(conv.briefOf(C({ brief: written, state: 'working', questions: [q],
      doing: [{ row: '2', title: 'Brief view', since: now - 12 * MIN, note: '' }] })));
    const pg = runPage(a.v.html());
    pg.post(a.last());
    const { els } = pg;
    const sections = els.bsections.children.map((c) => c.textContent);
    const shown = [els.brief.style.display, els.main.style.display, els.btitle.textContent, sections, els.blive.textContent,
      els.bquestions.children.map((c) => c.textContent)];
    pg.fire(els.bquestions.children[1], 'click');
    pg.fire(els.bopen, 'click');
    pg.post({ type: 'show', key: 'k', conversation: 'c', row: 'r', question: 'Q', note: '', detail: '', draft: '', running: true, busy: false,
      notRunning: '', status: '', failed: false });
    eq([shown, pg.sent.filter((m) => m.type !== 'tz'), els.brief.style.display, els.main.style.display],
      [['flex', 'none', 'Ship the brief',
        ['Summarywritten 2h agoAdds the brief to the Conversations panel.',
          'Where it standswritten 10m agoMay be out of date: the conversation has run since this was written.'
            + 'DoingWriting testsLatestShared hooks passNextCommit'],
        'Now: working \u00b7 2. Brief view (doing for 12m)', ['Waiting for your answer', '3. Merge now?asked 4m ago']],
      [{ type: 'ask', key: a.last().key, row: '3' }, { type: 'open', key: a.last().key }], 'none', 'flex'],
    'the page draws the brief, a question on it asks to be answered, its button asks for the conversation, and a question replaces it');
  }

  undo();

  /* ── The tree and the window ── */
  {
    const ws = tmp('brief-ws'), dir = tmp('brief-plans');
    fs.writeFileSync(path.join(dir, T + '.json'), JSON.stringify({ nodes: [{ title: 'row', state: 'todo' }], brief: { summary: 'S', summaryAt: iso(now) } }));
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9 } });
    const { vscode, control } = b;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const revealed = [];
    const changed = new vscode.EventEmitter();
    const make = (id, features) => ({ protocol: 1, features, id, label: id, planPath: (s) => path.join(dir, s + '.json'), planDir: () => dir,
      listConversations: async () => [{ sessionId: T, title: id + ' task', cwd: ws, state: 'idle', running: true, lastActiveAt: now }],
      onDidChangeConversations: changed.event, reveal: async (s) => { revealed.push([id, s]); return true; } });
    const withBrief = make('codex', ['brief']);
    b.api.registerSource(withBrief);
    b.api.registerSource(make('claude-code', []));
    await wait(120);
    const tree = control.state.views['agentPlus.conversations'].provider;
    const rows = () => tree.getChildren().filter((e) => e.kind === 'conversation');
    const items = rows().map((e) => [e, tree.getTreeItem(e)]);
    const by = (id) => items.find(([e]) => e.c.sourceId === id);
    const [, cx] = by('codex'), [ccE, cc] = by('claude-code');
    eq([cx.command.command, cx.command.arguments[0].brief && cx.command.arguments[0].brief.summary, cc.command.command,
      cx.contextValue, cc.contextValue],
    ['agentPlus.showBrief', 'S', 'agentPlus.openConversation', 'agentPlusConversation', 'agentPlusConversation'],
    'a click shows the brief for a source that lists it, and goes to the conversation for one that does not');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const inline = pkg.contributes.menus['view/item/context'].find((m) => m.command === 'agentPlus.goToConversation');
    const icon = pkg.contributes.commands.find((c) => c.command === 'agentPlus.goToConversation');
    eq([inline && inline.group, inline && /view == agentPlus\.conversations/.test(inline.when) && /viewItem == agentPlusConversation/.test(inline.when),
      icon && icon.icon], ['inline', true, '$(arrow-right)'], 'every conversation row carries an arrow that goes to the conversation');
    await control.state.handlers['agentPlus.goToConversation'](ccE);
    await control.state.handlers['agentPlus.showBrief'](cx.command.arguments[0]);
    const view = control.state.webviews['agentPlus.answer'];
    eq([revealed, control.state.commands.some((c) => c[0] === 'agentPlus.answer.focus'), view.current && view.current.mode],
      [[['claude-code', T]], true, 'brief'], 'the arrow goes to its conversation, and the brief opens in the Answer view');
    withBrief.features = [];
    changed.fire();
    await wait(400);
    const after = rows().find((e) => e.c.sourceId === 'codex');
    eq(tree.getTreeItem(after).command.command, 'agentPlus.openConversation',
      'a source that stops listing the brief goes back to opening the conversation once it says its conversations changed');
    b.close();
  }
};
