// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Conversations view, a tab of its own in the panel: one row per conversation of this workspace, and under it its
 * questions and its `doing` rows. src/conversations.js builds the list. From src/conversations-view.js of
 * vscode-claude-code-extras bb28f51.
 *
 * The host sets `source` ({ id, label }) on each row, `briefs` when that source lists 'brief' in its features, and, with
 * more than one source registered, `icon` when the logo can be drawn (src/sourceicons.js).
 *
 * Clicking a conversation shows its brief in the Answer view when its source supports briefs, and goes to the
 * conversation otherwise. The arrow at the row's end goes to the conversation either way.
 */
const vscode = require('vscode');
const { ageSince } = require('./workplan-view');
const { textFor } = require('./conversations-text');
const { keyPart } = require('./sources');

/* Shapes that differ, so the states can be told apart without colour. */
const LOOK = {
  prompt: ['shield', 'charts.orange'],
  needs: ['question', 'charts.orange'],
  working: ['sync~spin', 'charts.blue'],
  unread: ['circle-filled', 'charts.green'],
  idle: ['circle-outline', 'descriptionForeground'],
};

/*
 * The question a row is asking, in the shape the Answer view is handed it in. Built in one place, so the question the
 * reader clicked and the one handed back on a later pass (AnswerView.revise) cannot differ in shape.
 */
function questionOf(c, q, from = (c.source && c.source.id) || c.sourceId || '') {
  return {
    sourceId: from, sessionId: c.sessionId, row: q.row, rowTitle: q.title, question: q.question, note: q.note,
    detail: q.detail, since: q.since, conversation: c.title, running: c.running,
    open: { sourceId: from, sessionId: c.sessionId, cwd: c.cwd, title: c.title },
  };
}

/* How a conversation's brief is named in the Answer view. Unlike a question's name it has two parts, so the two can
   never be the same. */
const briefKey = (sourceId, sessionId) => 'brief:' + keyPart(sourceId || '') + '/' + keyPart(sessionId);

/* The argument of showBrief for conversation `c`, built in one place so that the page opened by a click and the one
   revised on a later pass have the same shape. */
function briefOf(c, from = (c.source && c.source.id) || c.sourceId || '') {
  return {
    key: briefKey(from, c.sessionId), sourceId: from, sessionId: c.sessionId, title: c.title, state: c.state,
    running: c.running, lastActiveAt: c.since, hasPlan: c.hasPlan, brief: c.brief || null, top: c.top || [],
    doing: c.doing, questions: c.questions.map((q) => questionOf(c, q, from)),
    open: { sourceId: from, sessionId: c.sessionId, cwd: c.cwd, title: c.title },
  };
}

class ConversationsProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.data = { running: [], stopped: [], asks: 0 };
    this.problem = '';
    this.lang = 'en';
    this.signature = '';
  }

  /* Returns whether the tree changed; ages are part of the comparison. */
  set(data, problem = '', lang = 'en', now = Date.now()) {
    this.data = data || { running: [], stopped: [], asks: 0 };
    this.problem = problem || '';
    this.lang = lang;
    const ages = [];
    for (const c of this.data.running.concat(this.data.stopped)) {
      ages.push(ageSince(c.since, now));
      for (const r of c.doing.concat(c.questions)) ages.push(ageSince(r.since, now));
    }
    const signature = JSON.stringify([this.problem, lang, this.data.running, this.data.stopped, ages]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this._emitter.fire();
    return true;
  }

  getChildren(element) {
    if (!element) {
      const rows = this.data.running.map((c) => ({ kind: 'conversation', c }));
      if (this.data.stopped.length) rows.push({ kind: 'stopped' });
      if (this.problem) rows.unshift({ kind: 'problem' });
      return rows;
    }
    if (element.kind === 'stopped') return this.data.stopped.map((c) => ({ kind: 'conversation', c }));
    if (element.kind === 'conversation') {
      const c = element.c;
      return c.questions.map((q) => ({ kind: 'question', c, q })).concat(c.doing.map((d) => ({ kind: 'doing', c, d })));
    }
    return [];
  }

  getTreeItem(element) {
    const t = textFor(this.lang);
    if (element.kind === 'problem') {
      const item = new vscode.TreeItem(t.problem);
      item.id = 'conversations/!problem';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      item.tooltip = this.problem;
      return item;
    }
    if (element.kind === 'stopped') {
      const item = new vscode.TreeItem(t.stopped(this.data.stopped.length), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'conversations/!stopped';
      item.iconPath = new vscode.ThemeIcon('history');
      return item;
    }
    const c = element.c;
    const from = c.source && c.source.id ? c.source : null;
    const sourceId = from ? from.id : c.sourceId || '';
    const target = { sourceId, sessionId: c.sessionId, cwd: c.cwd, title: c.title };
    const open = { command: 'agentPlus.openConversation', title: 'Go to the conversation', arguments: [target] };
    /* Encoded so that ('a', 'b/c') and ('a/b', 'c') give different ids. */
    const where = (c.running ? '' : 'stopped/') + keyPart(sourceId) + '/' + keyPart(c.sessionId);
    if (element.kind === 'conversation') {
      const kids = c.questions.length + c.doing.length;
      const expanded = c.running && (c.state === 'needs' || c.state === 'prompt' || c.state === 'working');
      const item = new vscode.TreeItem(c.title, !kids ? vscode.TreeItemCollapsibleState.None
        : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'conversations/' + where;
      const [icon, color] = LOOK[c.state] || LOOK.idle;
      item.iconPath = (from && c.icon) || new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.description = [t.state[c.state], c.questions.length ? t.questions(c.questions.length) : '',
        c.hasPlan ? t.open(c.open) : t.noPlan, c.unknown ? t.unknown(c.unknown) : ''].filter(Boolean).join(' · ');
      item.tooltip = [c.title, from ? from.label : '', t.state[c.state], c.cwd ? t.folder(c.cwd) : '',
        c.unknown ? t.unknownTip(c.unknown) : ''].filter(Boolean).join('\n');
      item.contextValue = 'agentPlusConversation';
      item.command = c.briefs
        ? { command: 'agentPlus.showBrief', title: 'Show where it stands', arguments: [briefOf(c, sourceId)] } : open;
      return item;
    }
    if (element.kind === 'question') {
      const q = element.q;
      const item = new vscode.TreeItem(`${q.row}. ${q.question}`);
      item.id = `conversations/${where}/?${q.row}`;
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.orange'));
      item.description = t.asked(ageSince(q.since));
      item.tooltip = `${q.question}\n\n${q.row}. ${q.title}`;
      item.command = { command: 'agentPlus.answerQuestion', title: 'Answer it', arguments: [questionOf(c, q, sourceId)] };
      return item;
    }
    const d = element.d;
    const item = new vscode.TreeItem(`${d.row}. ${d.title}`);
    item.id = `conversations/${where}/>${d.row}`;
    const busy = c.state === 'working';
    item.iconPath = busy ? new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('descriptionForeground'));
    item.description = busy ? t.doing(ageSince(d.since)) : t.lastWorked(ageSince(c.since));
    item.tooltip = `${d.row}. ${d.title}\n\n${item.description}`;
    item.command = open;
    return item;
  }
}

module.exports = { ConversationsProvider, questionOf, briefOf, briefKey, LOOK };
