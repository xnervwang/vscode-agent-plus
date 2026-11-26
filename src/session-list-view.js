// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The session list's webview view (agentPlus.sessions): it hands the page (src/page/session-list-page.js) the model of
 * src/session-list.js, and hands the list what the page asks for. The page is sent a model only while it is on screen
 * and only when it differs from the last one sent.
 *
 * Each agent's logo is an SVG file in the agent's own extension, outside this extension's folder, which the page may
 * not load from. The view reads it once and sends it as a data: URI, with any script taken out; an SVG drawn as an
 * image runs no script in any case.
 *
 * The view's badge counts the conversations that need the user, as Claude Code's own list does.
 */
const fs = require('fs');
const crypto = require('crypto');
const { envelope } = require('./envelope');

const PAGE_FILES = ['session-list-page.js', 'session-list-page.css'];
const MAX_LOGO_BYTES = 256 * 1024;

const logos = new Map();
/* The SVG at `file` as a data: URI, or '' when it cannot be read or is too large. */
function logoUri(file) {
  if (!file) return '';
  if (logos.has(file)) return logos.get(file);
  let uri = '';
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size <= MAX_LOGO_BYTES) {
      const svg = fs.readFileSync(file, 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '');
      if (/<svg\b/i.test(svg)) uri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    }
  } catch (_) { uri = ''; }
  logos.set(file, uri);
  return uri;
}

class SessionListView {
  /* `list` is src/session-list.js's; `extensionUri` this extension's folder; `envelopeOf()` the envelope to draw. */
  constructor(vscode, { list, extensionUri, envelopeOf = () => envelope(vscode), say = () => {} }) {
    this.vscode = vscode;
    this.list = list;
    this.extensionUri = extensionUri;
    this.envelopeOf = envelopeOf;
    this.say = say;
    this.view = null;
    this.posted = '';
    this.selection = [];
    this.sub = list.onDidChange(() => this.post());
  }

  get visible() { return !!(this.view && this.view.visible); }

  resolveWebviewView(view) {
    const vscode = this.vscode;
    this.view = view;
    this.posted = '';
    const dir = vscode.Uri.joinPath(this.extensionUri, 'src', 'page');
    view.webview.options = { enableScripts: true, localResourceRoots: [dir] };
    const [js, css] = PAGE_FILES.map((f) => view.webview.asWebviewUri(vscode.Uri.joinPath(dir, f)));
    view.webview.html = pageHtml({ js: String(js), css: String(css), csp: view.webview.cspSource, nonce: crypto.randomBytes(16).toString('hex') });
    const subs = [
      view.webview.onDidReceiveMessage((msg) => { this.receive(msg || {}).catch((e) => this.say(`session list: ${(e && e.message) || e}`)); }),
      view.onDidChangeVisibility(() => { if (view.visible) { this.posted = ''; this.post(); this.list.schedule(); } }),
    ];
    view.onDidDispose(() => { for (const d of subs) { try { d.dispose(); } catch (_) { /* gone */ } } if (this.view === view) this.view = null; });
    this.list.schedule();
  }

  /* The model as the page draws it: with each agent's logo, in both forms, and the envelope. */
  pageModel() {
    const m = this.list.model();
    const out = Object.assign({}, m, { logos: {}, envelope: this.envelopeOf() });
    for (const s of m.sources || []) out.logos[s.id] = s.logo ? { light: logoUri(s.logo.light), dark: logoUri(s.logo.dark) } : null;
    out.sources = (m.sources || []).map((s) => ({ id: s.id, label: s.label, create: s.create }));
    return out;
  }

  post() {
    const m = this.list.model();
    if (this.view) {
      const n = (m.counts && m.counts.needs) || 0;
      this.view.badge = n ? { value: n, tooltip: `${n} conversation${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` } : undefined;
    }
    if (!this.visible) return false;
    const model = this.pageModel();
    const json = JSON.stringify(model);
    if (json === this.posted) return false;
    this.posted = json;
    Promise.resolve(this.view.webview.postMessage({ type: 'model', model })).catch(() => { this.posted = ''; });
    return true;
  }

  /* Anything else for the page: { type: 'search' }, { type: 'startRenameGroup', groupId } and the like. */
  tell(msg) {
    if (!this.view) return false;
    Promise.resolve(this.view.webview.postMessage(msg)).catch(() => {});
    return true;
  }

  /* What the page asks for. */
  async receive(msg) {
    const list = this.list;
    const keys = Array.isArray(msg.keys) ? msg.keys.filter((k) => typeof k === 'string').slice(0, 2000) : [];
    const str = (v) => (typeof v === 'string' ? v : '');
    switch (msg.kind) {
      case 'ready': this.posted = ''; this.post(); return undefined;
      case 'select': this.selection = keys; return undefined;
      case 'open': return list.open(str(msg.key));
      case 'act': {
        const r = await list.act(str(msg.name), keys, msg.pick === undefined ? undefined : str(msg.pick));
        if (r && typeof r === 'object' && r.renameGroup) this.tell({ type: 'startRenameGroup', groupId: r.renameGroup });
        return r;
      }
      case 'groupAct': {
        const r = await list.groupAct(str(msg.name), str(msg.groupId), msg.pick === undefined ? undefined : str(msg.pick));
        if (r && typeof r === 'object' && r.renameGroup) this.tell({ type: 'startRenameGroup', groupId: r.renameGroup });
        return r;
      }
      case 'rename': return list.rename(str(msg.key), str(msg.title));
      case 'renameGroup': return list.renameGroup(str(msg.groupId), str(msg.name));
      case 'move': return list.moveTo(keys, str(msg.section));
      case 'create': return list.create(str(msg.sourceId), str(msg.where));
      case 'newSource': return list.chooseNew(str(msg.sourceId), str(msg.where));
      case 'wantDetail': return list.wantDetail(keys);
      case 'accountLink': return list.accountLink(str(msg.sourceId), Number.isInteger(msg.i) ? msg.i : -1);
      case 'noticeAction': return list.noticeAction(str(msg.sourceId), Number.isInteger(msg.i) ? msg.i : -1);
      case 'trust': return this.vscode.commands.executeCommand('workbench.trust.manage');
      default: return undefined;
    }
  }

  dispose() { try { this.sub.dispose(); } catch (_) { /* gone */ } }
}

function pageHtml({ js, css, csp, nonce }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}'; img-src ${csp} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root" class="sl-root" tabindex="0" data-vscode-context='{"preventDefaultContextMenuItems":true}'></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

module.exports = { SessionListView, pageHtml, logoUri, PAGE_FILES, MAX_LOGO_BYTES };
