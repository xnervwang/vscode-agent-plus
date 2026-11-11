// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Starts the host: the registration interface other extensions get from activate(), the check for whether anything
 * here uses this extension at all, and the views (src/views.js), which are built only once something does.
 *
 * start() returns before any other extension has activated and does nothing that waits: dependents are found in the
 * installed manifests, and everything that touches the disk is deferred and runs only while there is a dependent and
 * the workspace is trusted.
 */
const vscode = require('vscode');
const sources = require('./sources');
const dependents = require('./dependents');
const compat = require('./compat');
const PACKAGE = require('../package.json');

const FAMILY = 'agent-plus';
/*
 * The views, the status bar entry and the commands are hidden by one context key, and it reads the other way round:
 * they show unless agentPlus.alone says this extension is installed with nothing that uses it. A key this extension
 * sets does not exist until activate() has run, and VS Code puts a window's panel back while extensions are still
 * starting: a view whose `when` wants a key of ours would be inactive at that moment (viewContainerModel.ts sets
 * state.active from the `when` when the view is added, which happens as the manifests are read), its container would
 * come up with nothing in it, and the panel the window had open would be replaced by another. Reading the key the other
 * way round means an unset key shows the views, which is what a window with a dependent installed wants. The price is
 * that a window which really is alone draws them for a moment before the key is set.
 *
 * The key is set the same way in Restricted Mode, where nothing that uses this extension can be seen at all: Claude
 * Code does not run there, and VS Code disables an extension whose own dependency is disabled. The views would be empty
 * either way, and what the reader asked for is that nothing is shown without a feature extension. What an untrusted
 * window does not do is say anything or write down that it has: a dependent that is only disabled, not missing, would
 * make that notice wrong, and once said it is said for good. It is worked out again on onDidGrantWorkspaceTrust.
 */
const ALONE_KEY = 'agentPlus.alone';
const HAD_KEY = 'agentPlus.hadDependents';
const TOLD_KEY = 'agentPlus.toldAlone';
/* How long after start the one-off notices wait, so they do not compete with the window opening. */
const NOTICE_DELAY_MS = 4000;
/* Every command the manifest declares. They are registered at once, so none is ever missing, and handed to the views
   once those exist. */
const COMMANDS = ['refreshWorkPlan', 'openWorkPlanFile', 'showWorkPlanDetail', 'showConversations', 'answerQuestion',
  'openConversation', 'showBrief', 'goToConversation', 'showStatus', 'restoreWebviewRequestLimit', 'chooseTokenMode'];

/* The interface returned when start() threw: present, so a dependent extension can tell why it was not taken. */
function unavailable(error) {
  const why = 'Agent Plus could not start: ' + String((error && error.message) || error || 'unknown error');
  return Object.freeze({
    family: FAMILY, version: PACKAGE.version, protocol: sources.PROTOCOL, accepts: sources.ACCEPTS.slice(), features: [],
    registerSource: () => ({ accepted: false, code: sources.REFUSED.failed, reason: why, registration: null }),
  });
}

const disposable = (fn) => (typeof vscode.Disposable === 'function' ? new vscode.Disposable(fn) : { dispose: fn });

/*
 * `opts.views(host)` builds the views and returns { attach(entry), detach(entry), dispose() } (src/views.js); without
 * it, sources register and nothing is drawn. `opts.limit` and `opts.tokenMode` build the request limit and the token
 * mode's notice and status bar entry (src/request-limit.js, src/token-choice.js). `opts.fetch` replaces fetch() for the
 * gallery lookups and `opts.noticeDelayMs` the wait before the one-off notices, in tests; `opts.viewOptions` is passed
 * on to the views.
 */
function start(context, log, opts = {}) {
  const say = (m) => { try { if (log) log.appendLine(`${new Date().toISOString()} ${m}`); } catch (_) { /* no log */ } };
  const memento = context.globalState;
  const core = { version: String(PACKAGE.version), accepts: sources.ACCEPTS.slice(), protocol: sources.PROTOCOL };
  const registry = new sources.Registry();
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); try { fn(); } catch (e) { say(`${(e && e.stack) || e}`); } }, ms); timers.add(t); return t; };
  let closing = false;
  let views = null;
  const host = {
    vscode, context, say, registry, core, later,
    trusted: () => vscode.workspace.isTrusted !== false,
    closing: () => closing,
  };

  /* VS Code's webview request limit (src/request-limit.js), when the caller provides one. */
  const limit = typeof opts.limit === 'function' ? opts.limit(host, { home: opts.home }) : null;
  /* Built before the first look for dependents below: that look writes to globalState, and this has to read it as an
     earlier version left it. */
  let choice = null;
  if (typeof opts.tokenMode === 'function') {
    try { choice = opts.tokenMode(host, { home: opts.home }); } catch (e) { say(`the token mode could not start: ${(e && e.stack) || e}`); choice = null; }
  }

  /* ── Whether anything uses this extension ── */
  let deps = [];
  host.dependents = () => deps.slice();
  let active = null;
  const setActive = (on) => {
    if (on === active) return;
    active = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', ALONE_KEY, !on)).catch(() => {});
    if (on && !views && typeof opts.views === 'function' && !closing) {
      try { views = opts.views(host, Object.assign({ home: opts.home, limit }, opts.viewOptions)); } catch (e) { say(`the views could not be built: ${(e && e.stack) || e}`); views = null; }
      if (views) for (const entry of registry.list()) attachSafely(entry);
    }
    if (views && typeof views.setActive === 'function') { try { views.setActive(on); } catch (_) { /* drawn next time */ } }
    if (choice) { try { choice.setActive(on); } catch (e) { say(`token mode entry: ${(e && e.message) || e}`); } }
  };
  const attachSafely = (entry) => { try { views.attach(entry); } catch (e) { say(`could not show ${entry.id}: ${(e && e.message) || e}`); } };
  const rescan = () => {
    deps = dependents.dependentsOf(vscode.extensions.all);
    if (deps.length && memento) {
      if (!memento.get(HAD_KEY)) Promise.resolve(memento.update(HAD_KEY, true)).catch(() => {});
      /* Something uses it after all, so a notice that it was alone is taken back: it was said too early, and the next
         time it really is alone it has to be free to say so. */
      const told = memento.get(TOLD_KEY, {}) || {};
      if (told.alone) {
        const { alone, ...rest } = told;
        Promise.resolve(memento.update(TOLD_KEY, rest)).catch(() => {});
      }
    }
    setActive(deps.length > 0 || registry.size > 0);
    return deps;
  };
  rescan();
  say(`started ${core.version}, protocol ${core.protocol}, accepting ${core.accepts.join(', ')}; `
    + (deps.length ? `used by ${deps.map((d) => `${d.id} ${d.version}`).join(', ')}` : 'nothing installed uses it'));

  /* Once per kind: alone since it was installed, or left alone by the extensions that used it. An untrusted window says
     nothing and writes nothing down: a dependent it cannot see may only be a disabled one (see the comment on
     ALONE_KEY), and a notice is said once for good. */
  const tellIfAlone = async () => {
    if (closing || !host.trusted()) return;
    const told = (memento && memento.get(TOLD_KEY, {})) || {};
    const kind = dependents.notice({ dependents: rescan(), hadDependents: !!(memento && memento.get(HAD_KEY)), told });
    if (!kind) return;
    if (memento) await memento.update(TOLD_KEY, Object.assign({}, told, { [kind]: true }));
    if (kind === 'orphaned') {
      const text = 'Agent Plus does nothing on its own, and no extension that uses it is installed here any more. You can '
        + 'uninstall it in the Extensions view.';
      /* Uninstalling cannot put VS Code's request limit back: the uninstall hook runs where this extension is
         installed, which in a remote window is not the client, and deactivate runs after the extension host has
         dropped its connection to the client. This notice is the moment someone is about to uninstall. */
      const raised = limit && typeof limit.raised === 'function' ? await limit.raised().catch(() => false) : false;
      if (!raised) { vscode.window.showInformationMessage(text); return; }
      const put = 'Put Back the Request Limit';
      const pick = await vscode.window.showInformationMessage(text + ' VS Code\'s webview request limit is still 1000000, and '
        + 'uninstalling does not put it back: put it back first.', put);
      if (pick === put) await limit.putBack();
      return;
    }
    const buttons = dependents.KNOWN.map((k) => `Install ${k.name}`);
    const used = dependents.nameList(dependents.KNOWN.map((k) => k.name));
    const pick = await vscode.window.showInformationMessage(`Agent Plus is used by ${used}, `
      + 'which install it themselves. On its own it does nothing.', ...buttons);
    const chosen = dependents.KNOWN[buttons.indexOf(pick)];
    if (chosen) await vscode.commands.executeCommand('workbench.extensions.installExtension', chosen.id);
  };

  /* A dependent whose manifest declares a protocol this build does not take is told about before it even registers. */
  const offerFor = (ext) => {
    const who = compat.behind(ext.protocol, core.accepts);
    if (!who) return Promise.resolve('');
    return compat.offer({ vscode, memento, who, ext, core, fetch: opts.fetch, say });
  };
  const checkDeclared = () => {
    if (closing) return;
    for (const ext of rescan()) offerFor(ext).catch((e) => say(`update notice for ${ext.id}: ${(e && e.message) || e}`));
  };
  /*
   * The notice waits, and every change to the installed extensions makes it wait again. A remote installs extensions
   * one at a time, and this one can be in place for several seconds before whichever extension pulled it in: saying it
   * is alone then would be wrong, and it is said once for good.
   */
  const noticeWait = Number.isFinite(opts.noticeDelayMs) ? opts.noticeDelayMs : NOTICE_DELAY_MS;
  let noticeTimer = 0;
  const armNotice = () => {
    if (closing) return;
    if (noticeTimer) { clearTimeout(noticeTimer); timers.delete(noticeTimer); }
    noticeTimer = later(() => {
      noticeTimer = 0;
      tellIfAlone().catch((e) => say(`alone notice: ${(e && e.message) || e}`));
      if (choice) choice.ask().catch((e) => say(`token mode notice: ${(e && e.message) || e}`));
    }, noticeWait);
  };
  armNotice();
  later(() => checkDeclared(), noticeWait);
  context.subscriptions.push(vscode.extensions.onDidChange(() => { rescan(); checkDeclared(); armNotice(); if (choice) choice.paint(); }));
  /* Trusting the workspace is when an extension disabled with the agent it extends comes back, and the first point at
     which being alone means anything. */
  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { rescan(); armNotice(); }));
  }

  /* ── Registration ── */
  const unhook = (subs) => { for (const d of subs) { try { d.dispose(); } catch (_) { /* already disposed */ } } subs.length = 0; };
  const register = (source) => {
    const fail = (code, reason) => ({ accepted: false, code, reason, registration: null });
    if (closing) return fail(sources.REFUSED.closing, 'the window is closing');
    const reserved = registry.reserve(source, sources.idOf(source));
    if (!reserved.ok) {
      if (reserved.code === sources.REFUSED.coreTooOld || reserved.code === sources.REFUSED.sourceTooOld) {
        const id = sources.extensionOf(source);
        const known = rescan().find((d) => d.id === id);
        const ext = known ? Object.assign({}, known, { protocol: sources.get(source, 'protocol') })
          : id ? { id, name: sources.labelOf(source) || id, version: '', protocol: sources.get(source, 'protocol') } : null;
        if (ext) offerFor(ext).catch((e) => say(`update notice for ${id}: ${(e && e.message) || e}`));
      }
      return fail(reserved.code, reserved.why);
    }
    const entry = reserved.entry;
    let remove = () => {};
    try {
      remove = registry.commit(entry);
    } catch (e) {
      registry.release(entry);
      return fail(sources.REFUSED.failed, 'it could not be attached: ' + ((e && e.message) || e));
    }
    /* Building the views attaches every registered source, this one included. */
    const built = !!views;
    setActive(true);
    if (views && built) attachSafely(entry);
    let gone = false;
    /*
     * Order matters. Listening stops first and the registry drops the entry next, so that when the views work out which
     * conversation is in front again they cannot offer the tab back to the source that is going away: it is still in
     * the registry while views.detach() runs, and the tab in front may well be its own. Whether anything still uses
     * this extension is worked out last, once the registry is as it will be.
     */
    const registration = disposable(() => {
      if (gone) return;
      gone = true;
      unhook(entry.subs);
      remove();
      try { if (views) views.detach(entry); } catch (_) { /* already gone */ }
      say(`conversation source removed: ${entry.id}`);
      if (!closing) rescan();
    });
    return { accepted: true, code: '', reason: '', registration };
  };

  const agentPlus = Object.freeze({
    family: FAMILY,
    version: core.version,
    protocol: core.protocol,
    accepts: core.accepts.slice(),
    features: sources.FEATURES.slice(),
    registerSource(source) {
      let r;
      try { r = register(source); } catch (e) { r = { accepted: false, code: sources.REFUSED.failed, reason: String((e && e.message) || e), registration: null }; }
      say(r.accepted ? `conversation source registered: ${sources.labelOf(source)} (${sources.idOf(source)})`
        : `a conversation source was not registered (${r.code}): ${r.reason}`);
      return Object.freeze(r);
    },
  });

  /* ── Commands ── */
  const status = () => {
    const lines = [
      `Agent Plus ${core.version}: protocol ${core.protocol}, accepts ${core.accepts.join(', ')}`,
      `Workspace trusted: ${host.trusted() ? 'yes' : 'no (Restricted Mode: read only)'}`,
      `Extensions using it: ${deps.map((d) => `${d.id} ${d.version} (protocol ${d.protocol || 'not declared'})`).join(', ') || 'none'}`,
      ...(choice ? choice.statusLines() : []),
      ...(views ? views.commands.statusLines() : ['The views are not built: nothing here uses this extension.']),
    ];
    if (log) { for (const l of lines) log.appendLine(l); try { log.show(true); } catch (_) { /* no panel */ } }
    return lines;
  };
  const run = (name, args) => {
    if (name === 'showStatus') return status();
    if (name === 'restoreWebviewRequestLimit') return limit ? limit.putBack() : undefined;
    if (name === 'chooseTokenMode') return choice ? choice.choose() : undefined;
    const fn = views && views.commands[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  };
  for (const name of COMMANDS) {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(`agentPlus.${name}`, (...args) => {
        try { return Promise.resolve(run(name, args)).catch((e) => say(`${name}: ${(e && e.message) || e}`)); }
        catch (e) { say(`${name}: ${(e && e.message) || e}`); return undefined; }
      }));
    } catch (e) { say(`could not register agentPlus.${name}: ${(e && e.message) || e}`); }
  }

  context.subscriptions.push({ dispose: () => {
    closing = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (views) { try { views.dispose(); } catch (_) { /* closing anyway */ } views = null; }
    if (limit) { try { limit.dispose(); } catch (_) { /* closing anyway */ } }
    if (choice) { try { choice.dispose(); } catch (_) { /* closing anyway */ } }
    for (const entry of registry.list()) unhook(entry.subs);
    registry.clear();
  } });
  host.api = agentPlus;
  host.views = () => views;
  host.tokenChoice = () => choice;
  return agentPlus;
}

module.exports = { start, unavailable, FAMILY, ALONE_KEY, HAD_KEY, TOLD_KEY, NOTICE_DELAY_MS, COMMANDS };
