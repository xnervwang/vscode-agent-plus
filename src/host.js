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

const FAMILY = 'agent-work-plan';
const ACTIVE_KEY = 'agentWorkPlan.active';
const HAD_KEY = 'agentWorkPlan.hadDependents';
const TOLD_KEY = 'agentWorkPlan.toldAlone';
/* How long after start the one-off notices wait, so they do not compete with the window opening. */
const NOTICE_DELAY_MS = 4000;
/* Every command the manifest declares. They are registered at once, so none is ever missing, and handed to the views
   once those exist. */
const COMMANDS = ['refreshWorkPlan', 'openWorkPlanFile', 'showWorkPlanDetail', 'showConversations', 'answerQuestion',
  'openConversation', 'showStatus', 'restoreWebviewRequestLimit'];

/* The interface returned when start() threw: present, so a dependent extension can tell why it was not taken. */
function unavailable(error) {
  const why = 'Agent Work Plan could not start: ' + String((error && error.message) || error || 'unknown error');
  return Object.freeze({
    family: FAMILY, version: PACKAGE.version, protocol: sources.PROTOCOL, accepts: sources.ACCEPTS.slice(), features: [],
    registerSource: () => ({ accepted: false, code: sources.REFUSED.failed, reason: why, registration: null }),
  });
}

const disposable = (fn) => (typeof vscode.Disposable === 'function' ? new vscode.Disposable(fn) : { dispose: fn });

/*
 * `opts.views(host)` builds the views and returns { attach(entry), detach(entry), dispose() } (src/views.js); without
 * it, sources register and nothing is drawn. `opts.fetch` replaces fetch() for the gallery lookups and
 * `opts.noticeDelayMs` the wait before the one-off notices, in tests; `opts.viewOptions` is passed on to the views.
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
  const limit = typeof opts.limit === 'function' ? opts.limit(host) : null;

  /* ── Whether anything uses this extension ── */
  let deps = [];
  let active = null;
  const setActive = (on) => {
    if (on === active) return;
    active = on;
    Promise.resolve(vscode.commands.executeCommand('setContext', ACTIVE_KEY, on)).catch(() => {});
    if (on && !views && typeof opts.views === 'function' && !closing) {
      try { views = opts.views(host, Object.assign({ home: opts.home, limit }, opts.viewOptions)); } catch (e) { say(`the views could not be built: ${(e && e.stack) || e}`); views = null; }
      if (views) for (const entry of registry.list()) attachSafely(entry);
    }
    if (views && typeof views.setActive === 'function') { try { views.setActive(on); } catch (_) { /* drawn next time */ } }
  };
  const attachSafely = (entry) => { try { views.attach(entry); } catch (e) { say(`could not show ${entry.id}: ${(e && e.message) || e}`); } };
  const rescan = () => {
    deps = dependents.dependentsOf(vscode.extensions.all);
    if (deps.length && memento && !memento.get(HAD_KEY)) Promise.resolve(memento.update(HAD_KEY, true)).catch(() => {});
    setActive(deps.length > 0 || registry.size > 0);
    return deps;
  };
  rescan();
  say(`started ${core.version}, protocol ${core.protocol}, accepting ${core.accepts.join(', ')}; `
    + (deps.length ? `used by ${deps.map((d) => `${d.id} ${d.version}`).join(', ')}` : 'nothing installed uses it'));

  /* Once per kind: alone since it was installed, or left alone by the extensions that used it. */
  const tellIfAlone = async () => {
    if (closing) return;
    const told = (memento && memento.get(TOLD_KEY, {})) || {};
    const kind = dependents.notice({ dependents: rescan(), hadDependents: !!(memento && memento.get(HAD_KEY)), told });
    if (!kind) return;
    if (memento) await memento.update(TOLD_KEY, Object.assign({}, told, { [kind]: true }));
    if (kind === 'orphaned') {
      vscode.window.showInformationMessage('Agent Work Plan does nothing on its own, and no extension that uses it is installed '
        + 'here any more. You can uninstall it in the Extensions view.');
      return;
    }
    const buttons = dependents.KNOWN.map((k) => `Install ${k.name}`);
    const pick = await vscode.window.showInformationMessage('Agent Work Plan is used by Claude Code Extras and Codex Extras, '
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
  later(() => { tellIfAlone().catch((e) => say(`alone notice: ${(e && e.message) || e}`)); checkDeclared(); },
    Number.isFinite(opts.noticeDelayMs) ? opts.noticeDelayMs : NOTICE_DELAY_MS);
  context.subscriptions.push(vscode.extensions.onDidChange(() => { rescan(); checkDeclared(); }));

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
    const registration = disposable(() => {
      if (gone) return;
      gone = true;
      try { if (views) views.detach(entry); } catch (_) { /* already gone */ }
      unhook(entry.subs);
      remove();
      say(`conversation source removed: ${entry.id}`);
    });
    return { accepted: true, code: '', reason: '', registration };
  };

  const agentWorkPlan = Object.freeze({
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
      `Agent Work Plan ${core.version}: protocol ${core.protocol}, accepts ${core.accepts.join(', ')}`,
      `Workspace trusted: ${host.trusted() ? 'yes' : 'no (Restricted Mode: read only)'}`,
      `Extensions using it: ${deps.map((d) => `${d.id} ${d.version} (protocol ${d.protocol || 'not declared'})`).join(', ') || 'none'}`,
      ...(views ? views.commands.statusLines() : ['The views are not built: nothing here uses this extension.']),
    ];
    if (log) { for (const l of lines) log.appendLine(l); try { log.show(true); } catch (_) { /* no panel */ } }
    return lines;
  };
  const run = (name, args) => {
    if (name === 'showStatus') return status();
    if (name === 'restoreWebviewRequestLimit') return limit ? limit.putBack() : undefined;
    const fn = views && views.commands[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  };
  for (const name of COMMANDS) {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(`agentWorkPlan.${name}`, (...args) => {
        try { return Promise.resolve(run(name, args)).catch((e) => say(`${name}: ${(e && e.message) || e}`)); }
        catch (e) { say(`${name}: ${(e && e.message) || e}`); return undefined; }
      }));
    } catch (e) { say(`could not register agentWorkPlan.${name}: ${(e && e.message) || e}`); }
  }

  context.subscriptions.push({ dispose: () => {
    closing = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (views) { try { views.dispose(); } catch (_) { /* closing anyway */ } views = null; }
    if (limit) { try { limit.dispose(); } catch (_) { /* closing anyway */ } }
    for (const entry of registry.list()) unhook(entry.subs);
    registry.clear();
  } });
  host.dependents = () => deps.slice();
  host.api = agentWorkPlan;
  host.views = () => views;
  return agentWorkPlan;
}

module.exports = { start, unavailable, FAMILY, ACTIVE_KEY, HAD_KEY, TOLD_KEY, NOTICE_DELAY_MS, COMMANDS };
