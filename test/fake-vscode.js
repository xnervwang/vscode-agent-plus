// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The parts of the VS Code API this extension touches, enough to run it in Node. Adapted from codex-extras'
 * test/fake-vscode.js. The test drives tabs, installed extensions, workspace trust and the answers to notifications, and
 * reads back views, commands, status bar items, watchers, notifications and the clipboard. install() makes
 * require('vscode') return it.
 */
const Module = require('module');
const path = require('path');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn, thisArg) => {
      const f = (e) => fn.call(thisArg, e);
      this.listeners.add(f);
      return { dispose: () => this.listeners.delete(f) };
    };
  }
  fire(e) { for (const fn of [...this.listeners]) fn(e); }
  dispose() { this.listeners.clear(); }
}

class Disposable {
  constructor(fn) { this.fn = fn; }
  static from(...items) { return new Disposable(() => { for (const d of items) d.dispose(); }); }
  dispose() { if (this.fn) { const f = this.fn; this.fn = null; f(); } }
}

class Uri {
  constructor({ scheme = 'file', authority = '', path: p = '', query = '', fragment = '' }) {
    Object.assign(this, { scheme, authority, path: p, query, fragment });
  }
  static from(parts) { return new Uri(parts); }
  static parse(text) {
    const m = /^([a-z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(String(text)) || [];
    return new Uri({ scheme: m[1] || 'file', authority: m[2] || '', path: m[3] || '', query: m[4] || '', fragment: m[5] || '' });
  }
  static file(p) { return new Uri({ scheme: 'file', path: p }); }
  static joinPath(base, ...parts) { return new Uri({ ...base, path: path.posix.join(base.path, ...parts) }); }
  get fsPath() { return this.path; }
  with(change) { return new Uri({ ...this, ...change }); }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`; }
}

class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class MarkdownString {
  constructor(v = '') { this.value = v; }
  appendMarkdown(s) { this.value += s; return this; }
}
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
/* Positions here are offsets into the document's text, which is all the edits below need. */
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
}

/*
 * `answers` maps a notification's text (matched as a substring) to the button the test's user picks; a function gets
 * the message and the buttons. Unmatched notifications are dismissed. Set `state.onQuickPick(qp)` to answer a quick pick
 * when it is shown, with qp.accept(item) or qp.hide(). inspect() gives a key in `state.config` as its user setting.
 */
function create({ version = '1.145.0', trusted = true } = {}) {
  const tabsChanged = new EventEmitter();
  const groupsChanged = new EventEmitter();
  const extChanged = new EventEmitter();
  const trustGranted = new EventEmitter();
  const configChanged = new EventEmitter();
  const foldersChanged = new EventEmitter();
  const groups = [{ viewColumn: 1, tabs: [], activeTab: null, isActive: true }];
  const state = {
    commands: [], context: {}, extensions: [], clipboard: '', views: {}, webviews: {}, status: [], log: [], handlers: {},
    said: [], answers: [], watchers: [], config: {}, trusted, configWrites: [], quickPicks: [], external: [],
    documents: {}, shown: [],
  };
  /* An open document over `state.documents[uri.path]`; edits applied to it change that text and leave it unsaved. */
  const documentOf = (uri) => ({
    uri, isDirty: false,
    getText: () => state.documents[uri.path],
    positionAt: (offset) => offset,
  });
  const answer = (kind) => async (message, ...rest) => {
    const buttons = rest.filter((b) => typeof b === 'string');
    state.said.push({ kind, message, buttons });
    for (const [match, pick] of state.answers) {
      if (String(message).includes(match)) return typeof pick === 'function' ? pick(message, buttons) : pick;
    }
    return undefined;
  };
  const extensionList = () => state.extensions.map((e) => ({ isActive: true, exports: undefined, extensionPath: '', ...e,
    packageJSON: e.packageJSON || {} }));
  const vscode = {
    EventEmitter, Disposable, Uri, TabInputCustom, TabInputText, TabInputWebview, ThemeIcon, ThemeColor, TreeItem, MarkdownString,
    RelativePattern, Range, WorkspaceEdit,
    UIKind: { Desktop: 1, Web: 2 },
    version,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    window: {
      tabGroups: {
        get all() { return groups; },
        get activeTabGroup() { return groups.find((g) => g.isActive) || groups[0]; },
        onDidChangeTabs: tabsChanged.event,
        onDidChangeTabGroups: groupsChanged.event,
      },
      createTreeView: (id, opts) => {
        const view = { id, provider: opts.treeDataProvider, badge: undefined, description: undefined, title: undefined, message: undefined,
          visible: true, dispose() { view.disposed = true; } };
        state.views[id] = view;
        return view;
      },
      registerWebviewViewProvider: (id, provider) => { state.webviews[id] = provider; return new Disposable(() => {}); },
      createStatusBarItem: (id) => {
        const item = { id: typeof id === 'string' ? id : '', text: '', shown: false, show() { item.shown = true; }, hide() { item.shown = false; },
          dispose() { item.disposed = true; item.shown = false; } };
        state.status.push(item);
        return item;
      },
      createOutputChannel: () => ({ appendLine: (l) => state.log.push(l), append() {}, show() {}, dispose() {} }),
      showInformationMessage: answer('info'),
      showWarningMessage: answer('warning'),
      showErrorMessage: answer('error'),
      setStatusBarMessage: () => new Disposable(() => {}),
      createQuickPick: () => {
        const accepted = new EventEmitter(), hidden = new EventEmitter();
        const qp = { items: [], activeItems: [], selectedItems: [], title: '', placeholder: '', matchOnDetail: false, hidden: false,
          onDidAccept: accepted.event, onDidHide: hidden.event,
          show() { state.quickPicks.push(qp); if (state.onQuickPick) Promise.resolve().then(() => state.onQuickPick(qp)); },
          hide() { if (qp.hidden) return; qp.hidden = true; hidden.fire(); },
          accept(item) { qp.selectedItems = item ? [item] : []; accepted.fire(); },
          dispose() { qp.disposed = true; } };
        return qp;
      },
      showTextDocument: async (target, opts) => {
        state.commands.push(['showTextDocument', target]);
        const editor = { document: target, options: opts, revealed: [], revealRange(range) { editor.revealed.push(range); } };
        state.shown.push(editor);
        return editor;
      },
    },
    commands: {
      executeCommand: async (cmd, ...args) => {
        state.commands.push([cmd, ...args]);
        if (cmd === 'setContext') { state.context[args[0]] = args[1]; return undefined; }
        if (state.handlers[cmd]) return state.handlers[cmd](...args);
        if (state.onCommand) return state.onCommand(cmd, ...args);
        return undefined;
      },
      registerCommand: (id, fn) => {
        if (state.handlers[id]) throw new Error(`command '${id}' already exists`);
        state.handlers[id] = fn;
        return new Disposable(() => { if (state.handlers[id] === fn) delete state.handlers[id]; });
      },
    },
    extensions: {
      get all() { return extensionList(); },
      getExtension: (id) => extensionList().find((e) => e.id === id),
      onDidChange: extChanged.event,
    },
    env: {
      language: 'en', appName: 'Visual Studio Code', uriScheme: 'vscode', remoteName: undefined, appRoot: '', machineId: 'test-machine',
      openExternal: async (uri) => { state.external.push(String(uri)); return true; },
      clipboard: { writeText: async (t) => { state.clipboard = t; }, readText: async () => state.clipboard },
    },
    workspace: {
      get isTrusted() { return state.trusted; },
      onDidGrantWorkspaceTrust: trustGranted.event,
      openTextDocument: async (uri) => {
        if (typeof state.documents[uri.path] !== 'string') throw new Error(`cannot open ${uri.path}`);
        return documentOf(uri);
      },
      applyEdit: async (edit) => {
        for (const { uri, range, text } of edit.edits.slice().sort((a, b) => b.range.start - a.range.start)) {
          const was = state.documents[uri.path];
          state.documents[uri.path] = was.slice(0, range.start) + text + was.slice(range.end);
        }
        return true;
      },
      workspaceFolders: [],
      getConfiguration: (section) => ({
        get: (k, d) => {
          const key = section ? section + '.' + k : k;
          return key in state.config ? state.config[key] : d;
        },
        update: async (k, v) => {
          const key = section ? section + '.' + k : k;
          state.config[key] = v;
          state.configWrites.push([key, v]);
        },
        inspect: (k) => {
          const key = section ? section + '.' + k : k;
          return key in state.config ? { key, globalValue: state.config[key] } : { key };
        },
      }),
      onDidChangeConfiguration: configChanged.event,
      onDidChangeWorkspaceFolders: foldersChanged.event,
      createFileSystemWatcher: (pattern) => {
        const handlers = { create: [], change: [], delete: [] };
        const w = { pattern, disposed: false,
          onDidCreate: (fn) => { handlers.create.push(fn); return new Disposable(() => {}); },
          onDidChange: (fn) => { handlers.change.push(fn); return new Disposable(() => {}); },
          onDidDelete: (fn) => { handlers.delete.push(fn); return new Disposable(() => {}); },
          fire: (kind) => { for (const fn of handlers[kind]) fn(); },
          dispose() { w.disposed = true; } };
        state.watchers.push(w);
        return w;
      },
    },
  };
  /* Test controls. */
  const control = {
    state,
    groups,
    setTabs(list, active = 0) {
      groups[0].tabs = list.map((t) => ({ label: t.label || '', input: t.input, isActive: false, group: groups[0] }));
      groups[0].activeTab = groups[0].tabs[active] || null;
      if (groups[0].activeTab) groups[0].activeTab.isActive = true;
    },
    fireTabs(e = {}) { tabsChanged.fire({ opened: [], closed: [], changed: [], ...e }); },
    fireExtensions() { extChanged.fire(); },
    grantTrust() { state.trusted = true; trustGranted.fire(); },
    changeConfig(keys) { configChanged.fire({ affectsConfiguration: (k) => keys.some((x) => x === k || x.startsWith(k + '.')) }); },
    answer(match, pick) { state.answers.push([match, pick]); },
    fileTab(p) { return { label: path.basename(p), input: new TabInputText(Uri.file(p)) }; },
  };
  return { vscode, control };
}

/** Make require('vscode') return `vscode` from now on. Returns a function that undoes it. */
function install(vscode) {
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : orig.call(this, request, ...rest); };
  return () => { Module._load = orig; };
}

/** A Memento kept in memory. */
function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    keys: () => [...m.keys()] };
}

/** Clear this repository's own modules from the require cache, so the next require() loads them against a fresh fake. */
function fresh(root) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  }
}

module.exports = { create, install, memento, fresh, EventEmitter, Disposable, Uri };
