// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The Answer view, beside the Conversations tree in the same panel tab: the question clicked in the tree, the row it is
 * on, and a box to answer it in, several lines long. Sending hands the answer to src/answers.js, which gets it to the
 * window showing that conversation. What was typed and not sent is kept for each question while the window is open.
 * From src/answer-view.js of vscode-claude-code-extras bb28f51.
 *
 * Only an answer known to have been submitted clears its draft, and only while the box still holds exactly what was
 * sent: the reader can keep typing while one is on its way, and what they typed next is theirs. While one is on its
 * way, Send is disabled for that question, so a second click cannot send it twice. The page also reports the reader's
 * time zone, which it alone knows in a remote window.
 *
 * The question itself is not this view's to keep. The row it is on belongs to a plan another process writes, so the
 * wording can change, the row can be finished and the conversation can stop while the question sits here. revise() is
 * how the Conversations tree says what the row looks like now, and a row that is no longer asking is shown as one that
 * cannot be answered rather than quietly taking an answer to a question nobody is asking.
 *
 * When a conversation's row is clicked and its source supports briefs, it shows that conversation instead (showBrief),
 * on a page src/brief.js builds. reviseBrief() updates it on each pass of the tree, as revise() does for a question.
 */
const crypto = require('crypto');
const { textFor } = require('./conversations-text');
const { page } = require('./brief');
const { keyPart } = require('./sources');

/* How many questions' drafts are kept. A draft is only ever dropped to keep this from growing without end in a window
   left open for days, and the oldest goes first. */
const KEEP_DRAFTS = 200;

/* How a question is named: its source, its conversation and its row. Encoded so that two different triples cannot
   give the same name. */
const questionKey = (sourceId, sessionId, row) => keyPart(sourceId || '') + '/' + keyPart(sessionId) + '/' + row;

class AnswerView {
  /** `send(question, text)` sends an answer, `open(target)` goes to a conversation, `age(ms)` says how long ago,
      `clock(ms)` gives the reader's local time and `onTimeZone(zone)` hears the reader's time zone. */
  constructor({ send, open, age, clock, onTimeZone = () => {} }) {
    this.send = send;
    this.open = open;
    this.age = age;
    this.clock = clock;
    this.onTimeZone = onTimeZone;
    this.view = null;
    this.lang = 'en';
    this.current = null;
    this.restricted = false;
    this.drafts = new Map();
    this.states = new Map();
    /* What was sent for each question, so a draft is cleared only if it is still that text. */
    this.sent = new Map();
    /* The wording each state was recorded against: a row asked something else now is a different question, and the
       outcome of the last one does not belong to it. */
    this.asked = new Map();
    /* Which sending each question's state belongs to. The key is the row, and an answer to what the row asked before
       can still be on its way when it asks something new and that is answered too; its outcome is not this one's. */
    this.tickets = new Map();
    this.ticketSeq = 0;
  }

  /* Remembers the keys whose drafts and states may be kept, oldest first. */
  trim() {
    for (const map of [this.drafts, this.states, this.sent, this.asked, this.tickets]) {
      while (map.size > KEEP_DRAFTS) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    this.shownBrief = '';
    view.webview.onDidReceiveMessage((m) => this.receive(m));
    view.onDidDispose(() => { if (this.view === view) this.view = null; });
    this.paint();
  }

  receive(m) {
    if (m && m.type === 'tz' && typeof m.timeZone === 'string' && m.timeZone.length <= 64) {
      try { this.onTimeZone(m.timeZone); } catch (_) { /* the host's own zone stays */ }
      return;
    }
    if (!m) return;
    /*
     * A draft is kept for whichever question it names, not only for the one on screen. In a remote window the page's
     * last keystrokes can still be on their way when the reader clicks the next question, and a draft thrown away
     * because it arrived a moment late is text the reader typed and would not find again.
     */
    if (m.type === 'draft' && typeof m.text === 'string' && typeof m.key === 'string' && this.drafts.has(m.key)) {
      this.drafts.set(m.key, m.text);
      return;
    }
    if (!this.current || m.key !== this.current.key) return;
    if (this.current.mode === 'brief') {
      if (m.type === 'open' && this.current.open) this.open(this.current.open);
      return;
    }
    if (m.type === 'draft' && typeof m.text === 'string') {
      this.drafts.set(m.key, m.text);
      this.trim();
    } else if (m.type === 'send' && typeof m.text === 'string' && m.text.trim() && this.current.running && !this.restricted
      && !this.sending(m.key)) {
      this.drafts.set(m.key, m.text);
      this.sent.set(m.key, m.text);
      this.trim();
      this.send(this.current, m.text);
    } else if (m.type === 'open' && this.current.open) {
      this.open(this.current.open);
    }
  }

  /** Shows `q`, a question from the Conversations tree, ready to be answered. */
  show(q) {
    if (!q || !q.sessionId || !q.row) return;
    const key = questionKey(q.sourceId, q.sessionId, q.row);
    this.current = Object.assign({}, q, { key });
    /* A row asks one question at a time, and the key is the row. A row that has gone on to ask something else is a
       question of its own, so the outcome recorded against the last one is dropped; the draft stays, since the reader
       typed it and only they can say whether it still fits. */
    if (this.asked.has(key) && this.asked.get(key) !== (q.question || '')) {
      this.states.delete(key);
      this.sent.delete(key);
      this.tickets.delete(key);
    }
    this.asked.set(key, q.question || '');
    if (!this.drafts.has(key)) this.drafts.set(key, '');
    this.trim();
    this.paint(true);
  }

  /*
   * What the Conversations tree now says about the question on screen. `find(key)` gives the question as it stands, or
   * nothing when that row is no longer asking: the agent reworded it, finished the row, or the conversation stopped.
   */
  revise(find) {
    if (!this.current || this.current.mode === 'brief') return;
    let fresh = null;
    try { fresh = find(this.current.key); } catch (_) { fresh = null; }
    if (!fresh) {
      if (!this.current.gone) {
        this.current = Object.assign({}, this.current, { running: false, gone: true });
        this.paint();
      }
      return;
    }
    const next = Object.assign({}, fresh, { key: this.current.key, gone: false });
    const was = this.current;
    const same = ['question', 'rowTitle', 'note', 'detail', 'running', 'since', 'conversation']
      .every((k) => next[k] === was[k]) && !was.gone;
    this.current = next;
    if (this.asked.get(next.key) !== (next.question || '')) {
      this.states.delete(next.key);
      this.sent.delete(next.key);
      this.tickets.delete(next.key);
      this.asked.set(next.key, next.question || '');
    }
    if (!same) this.paint();
  }

  /** Shows `b`, a conversation from the Conversations tree (briefOf in src/conversations-view.js). */
  showBrief(b) {
    if (!b || !b.key || !b.sessionId) return;
    this.current = Object.assign({}, b, { mode: 'brief', gone: false });
    this.shownBrief = '';
    this.paint();
  }

  /*
   * `find(key)` returns the latest data for the conversation on screen, or null once it has left the list; the last
   * page then stays up with a line saying so.
   */
  reviseBrief(find) {
    if (!this.current || this.current.mode !== 'brief') return;
    let fresh = null;
    try { fresh = find(this.current.key); } catch (_) { fresh = null; }
    this.current = fresh ? Object.assign({}, fresh, { mode: 'brief', gone: false })
      : Object.assign({}, this.current, { running: false, gone: true });
    this.paint();
  }

  setLanguage(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.view) this.view.webview.html = this.html();
    this.shownBrief = '';
    this.paint();
  }

  setRestricted(on) {
    if (!!on === this.restricted) return;
    this.restricted = !!on;
    this.paint();
  }

  sending(key) {
    const st = this.states.get(key);
    return !!(st && st.kind === 'waiting');
  }

  /** Marks an answer to question `key` as on its way, and returns the ticket its outcome is to come back with. */
  begin(key) {
    const ticket = ++this.ticketSeq;
    this.tickets.set(key, ticket);
    this.setState(key, { kind: 'waiting' }, ticket);
    return ticket;
  }

  /**
   * Shows the outcome of the answer to question `key`, and clears its draft once it was submitted and the box still
   * holds the text that was sent. Anything typed while the answer was on its way is a draft of its own and is kept.
   * With a `ticket` (begin()), an outcome for any other sending of that question, or for what the row asked before, is
   * not shown.
   */
  setState(key, state, ticket) {
    if (ticket !== undefined && this.tickets.get(key) !== ticket) return;
    this.states.set(key, Object.assign({ at: Date.now() }, state));
    if (state.kind === 'submitted') {
      const text = this.sent.get(key);
      this.sent.delete(key);
      if (text !== undefined && this.drafts.get(key) === text) {
        this.drafts.set(key, '');
        if (this.view && this.current && this.current.key === key) this.view.webview.postMessage({ type: 'clear', key, text });
      }
    }
    this.trim();
    if (this.current && this.current.key === key) this.paint();
  }

  paint(focus) {
    if (!this.view) return;
    const t = textFor(this.lang);
    const q = this.current;
    if (!q) { this.view.webview.postMessage({ type: 'empty', text: t.answerEmpty }); return; }
    if (q.mode === 'brief') {
      const shown = page(q, t, this.age);
      const said = JSON.stringify(shown);
      if (said !== this.shownBrief) { this.shownBrief = said; this.view.webview.postMessage(shown); }
      return;
    }
    this.shownBrief = '';
    const state = this.states.get(q.key);
    const ago = this.age(q.since);
    this.view.webview.postMessage({
      type: 'show',
      key: q.key,
      focus: !!focus,
      conversation: q.conversation || '',
      row: t.answerRow(q.row, q.rowTitle || '', ago),
      question: q.question || '',
      note: q.note || '',
      detail: q.detail || '',
      draft: this.drafts.get(q.key) || '',
      running: !!q.running && !this.restricted,
      busy: !!(state && state.kind === 'waiting'),
      notRunning: this.restricted ? t.answerRestricted : q.gone ? t.answerGone : t.answerNotRunning,
      status: state ? t.answerState(state.kind, this.clock(state.at), state.reason || '') : '',
      failed: !!(state && !['submitted', 'drafted', 'waiting'].includes(state.kind)),
    });
  }

  html() {
    const t = textFor(this.lang);
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body { box-sizing: border-box; padding: 6px 10px; display: flex; flex-direction: column; gap: 6px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #empty { color: var(--vscode-descriptionForeground); margin-top: 4px; }
  #main { display: none; flex-direction: column; gap: 6px; flex: 1; min-height: 0; }
  #conversation { font-weight: 600; }
  #row { color: var(--vscode-descriptionForeground); }
  #question { white-space: pre-wrap; }
  details { color: var(--vscode-descriptionForeground); }
  details div { white-space: pre-wrap; max-height: 8em; overflow: auto; }
  textarea { flex: 1; min-height: 4em; resize: none; box-sizing: border-box; width: 100%; padding: 4px 6px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #bar { display: flex; align-items: center; gap: 8px; }
  #status { flex: 1; color: var(--vscode-descriptionForeground); }
  #status.failed { color: var(--vscode-errorForeground); }
  button { font-family: inherit; font-size: inherit; padding: 3px 10px; border: none; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  #brief { display: none; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow: auto; }
  #bhead { display: flex; align-items: center; gap: 8px; }
  #btitle { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
  #bsections { display: flex; flex-direction: column; gap: 8px; }
  .head { font-weight: 600; }
  .when, .label, #bgone { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .when { margin-left: 6px; }
  .label { margin-right: 4px; }
  .auto { color: var(--vscode-descriptionForeground); font-style: italic; }
  .stale { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
  .line { white-space: pre-wrap; overflow-wrap: anywhere; }
  #blive { color: var(--vscode-charts-blue, var(--vscode-foreground)); }
</style></head><body>
<div id="empty">${attr(t.answerEmpty)}</div>
<div id="main">
  <div id="conversation"></div>
  <div id="row"></div>
  <div id="question"></div>
  <details id="more"><summary>${attr(t.answerMore)}</summary><div id="detail"></div></details>
  <textarea id="text" placeholder="${attr(t.answerPlaceholder)}"></textarea>
  <div id="bar"><span id="status"></span>
    <button id="open" class="secondary">${attr(t.answerOpen)}</button>
    <button id="send">${attr(t.answerSend)}</button></div>
</div>
<div id="brief">
  <div id="bhead"><span id="btitle"></span><button id="bopen" class="secondary">${attr(t.answerOpen)}</button></div>
  <div id="bgone"></div>
  <div id="blive"></div>
  <div id="bsections"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let key = '', running = false, busy = false;
  const ready = () => { $('send').disabled = !running || busy || !$('text').value.trim(); };
  const send = () => { if (!$('send').disabled) vscode.postMessage({ type: 'send', key, text: $('text').value }); };
  $('text').addEventListener('input', () => { ready(); vscode.postMessage({ type: 'draft', key, text: $('text').value }); });
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  $('send').addEventListener('click', send);
  $('open').addEventListener('click', () => vscode.postMessage({ type: 'open', key }));
  $('bopen').addEventListener('click', () => vscode.postMessage({ type: 'open', key }));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const brief = (m) => {
    $('btitle').textContent = m.title;
    $('bgone').textContent = m.gone; $('bgone').style.display = m.gone ? '' : 'none';
    $('blive').textContent = m.live; $('blive').style.display = m.live ? '' : 'none';
    const box = $('bsections');
    box.textContent = '';
    for (const s of m.sections) {
      const sec = el('div', 'section');
      const head = el('div', 'head', s.head);
      if (s.when) head.appendChild(el('span', 'when', s.when));
      sec.appendChild(head);
      if (s.auto) sec.appendChild(el('div', 'auto', m.auto));
      if (s.stale) sec.appendChild(el('div', 'stale', s.stale));
      for (const l of s.lines) {
        const line = el('div', 'line');
        if (l.label) line.appendChild(el('span', 'label', l.label));
        line.appendChild(document.createTextNode(l.text));
        sec.appendChild(line);
      }
      box.appendChild(sec);
    }
  };
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    /* Cleared only while the box still holds what was sent: anything typed since belongs to the reader. */
    if (m.type === 'clear') { if (m.key === key && $('text').value === m.text) { $('text').value = ''; ready(); } return; }
    if (m.type === 'empty') {
      $('main').style.display = 'none'; $('brief').style.display = 'none'; $('empty').style.display = ''; $('empty').textContent = m.text;
      return;
    }
    if (m.type === 'brief') {
      $('empty').style.display = 'none'; $('main').style.display = 'none'; $('brief').style.display = 'flex';
      key = m.key;
      brief(m);
      return;
    }
    if (m.type !== 'show') return;
    $('empty').style.display = 'none';
    $('brief').style.display = 'none';
    $('main').style.display = 'flex';
    const fresh = m.key !== key;
    key = m.key;
    running = m.running;
    busy = m.busy;
    $('conversation').textContent = m.conversation;
    $('row').textContent = m.row;
    $('question').textContent = m.question;
    const more = [m.note, m.detail].filter(Boolean).join('\\n\\n');
    $('more').style.display = more ? '' : 'none';
    $('detail').textContent = more;
    if (fresh) { $('text').value = m.draft; $('more').open = false; }
    $('text').disabled = !running;
    $('status').textContent = running ? m.status : m.notRunning;
    $('status').className = m.failed ? 'failed' : '';
    ready();
    if (m.focus && running) $('text').focus();
  });
  try { vscode.postMessage({ type: 'tz', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '' }); } catch (_) { /* unknown */ }
</script></body></html>`;
  }
}

module.exports = { AnswerView, questionKey };
