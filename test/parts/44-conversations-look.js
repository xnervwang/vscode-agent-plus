// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * How the Conversations view draws a conversation's activity and a reply not seen (src/conversations-view.js): a dot in
 * the icon place for the activity, only the same blank space for one that has stopped, and an envelope as a file
 * decoration badge at the end of the row, so the two show together and a long title is cut before the envelope is.
 * With more than one source the dot is drawn on the source's logo (src/sourceicons.js).
 */
const fs = require('fs');
const path = require('path');
const fake = require('../fake-vscode');
const { boot } = require('../boot');

const ENVELOPE = '\u2709\uFE0F';
const ENVELOPE_TEXT = '\u2709\uFE0E';

module.exports = async ({ ok, bad, eq, tmp, root, wait }) => {
  {
    const { vscode, control } = fake.create();
    const undo = fake.install(vscode);
    fake.fresh(root);
    const cv = require(path.join(root, 'src', 'conversations-view.js'));
    const row = (id, activity, unseen, extra = {}) => Object.assign({ sourceId: 'claude-code', sessionId: id, title: 'T ' + id, cwd: '/w',
      running: true, state: 'idle', activity, unseen, questions: [], doing: [], open: 0, unknown: 0, hasPlan: false, since: 0, top: [] }, extra);
    const question = { row: '1', title: 'pick', question: 'Which one?', since: Date.now() - 1000 };
    const data = { running: [row('w', 'working', false), row('wu', 'working', true), row('b', 'background', false), row('bu', 'background', true),
      row('q', 'waiting', false, { state: 'needs', questions: [question] }), row('s', 'stopped', false), row('su', 'stopped', true),
      row('logo', 'background', true, { source: { id: 'codex', label: 'Codex' }, sourceId: 'codex', icon: { light: '/i/l.svg', dark: '/i/d.svg' } })],
    stopped: [], asks: 1 };
    const tree = new cv.ConversationsProvider();
    tree.set(data, '', 'en');
    const top = tree.getChildren().filter((e) => e.kind === 'conversation');
    const items = top.map((e) => tree.getTreeItem(e));
    const look = (it) => (it.iconPath && it.iconPath.id ? [it.iconPath.id, it.iconPath.color && it.iconPath.color.id] : ['logo', it.iconPath.light]);
    eq(items.map(look), [['circle-filled', 'charts.green'], ['circle-filled', 'charts.green'], ['circle', 'charts.green'], ['circle', 'charts.green'],
      ['circle-filled', 'charts.red'], ['blank', undefined], ['blank', undefined], ['logo', '/i/l.svg']],
    'the icon place holds the activity alone: green dot at work, green ring with only background work, red dot waiting, a blank of the same size stopped');
    const deco = tree.decorations;
    const badge = (it) => { const d = it.resourceUri ? deco.provideFileDecoration(it.resourceUri) : undefined; return d ? d.badge : ''; };
    eq(items.map(badge), ['', ENVELOPE, '', ENVELOPE, '', '', ENVELOPE, ENVELOPE],
      'a reply not seen is an envelope badge at the row end, beside whatever the icon place shows, the logo included');
    const long = 'A conversation title far longer than any side bar is wide, '.repeat(6).trim();
    const longTree = new cv.ConversationsProvider();
    longTree.set({ running: [row('long', 'stopped', true, { title: long })], stopped: [], asks: 0 }, '', 'en');
    const longItem = longTree.getTreeItem(longTree.getChildren().filter((e) => e.kind === 'conversation')[0]);
    const longText = [typeof longItem.label === 'string' ? longItem.label : longItem.label.label, longItem.description || ''].join(' ');
    const longBadge = longItem.resourceUri ? longTree.decorations.provideFileDecoration(longItem.resourceUri) : undefined;
    eq([longText.includes(long.slice(0, 40)), /\u2709/.test(longText), longBadge && longBadge.badge], [true, false, ENVELOPE],
      'a title too long for the row keeps the envelope out of the label VS Code cuts short: it is a badge drawn after the cut');
    let redrawn = 0;
    deco.onDidChangeFileDecorations(() => { redrawn++; });
    control.setTheme(1);
    eq([redrawn, items.map(badge)], [1, ['', ENVELOPE_TEXT, '', ENVELOPE_TEXT, '', '', ENVELOPE_TEXT, ENVELOPE_TEXT]],
      'in a light theme the envelope is the same character in its text form, since a colour font draws it white, and a theme change redraws it');
    control.setTheme(4);
    eq(badge(items[1]), ENVELOPE_TEXT, 'and so in a high contrast light theme');
    control.setTheme(2);
    const d = deco.provideFileDecoration(items[1].resourceUri);
    eq([d.color, typeof d.tooltip === 'string' && d.tooltip.length > 0, deco.provideFileDecoration(vscode.Uri.file('/w/a.txt')),
      new Set(items.filter((it) => it.resourceUri).map((it) => String(it.resourceUri))).size],
    [undefined, true, undefined, 4], 'the badge has no colour of its own, so the title keeps its colour; other resources get nothing; each row has its own address');
    eq([/reply you have not read/.test(items[1].tooltip), /reply you have not read/.test(items[0].tooltip), /only background work/i.test(items[2].tooltip)],
      [true, false, true], 'the tooltip says in words what the envelope and the ring mean');
    eq(items.every((it) => !(it.iconPath && it.iconPath.color && it.iconPath.color.id === 'charts.blue')), true, 'no conversation row is blue');
    const q = tree.getTreeItem(tree.getChildren(top[4])[0]);
    eq([q.iconPath.id, q.iconPath.color.id], ['question', 'charts.orange'], 'a question row keeps its question mark');
    tree.set(data, '', 'zh-cn');
    const zh = tree.getTreeItem(tree.getChildren().filter((e) => e.kind === 'conversation')[1]);
    eq(deco.provideFileDecoration(zh.resourceUri).tooltip === d.tooltip, false, 'the badge\'s tooltip follows the view\'s language');
    undo();
  }

  {
    const icons = require(path.join(root, 'src', 'sourceicons.js'));
    const idir = tmp('icons');
    const logo = path.join(idir, 'l.svg');
    fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h4"/></svg>');
    const read = (activity) => {
      const f = icons.iconsFor({ light: logo, dark: logo }, activity, path.join(idir, 'out'), new Map());
      return f ? [fs.readFileSync(f.light, 'utf8'), fs.readFileSync(f.dark, 'utf8')] : null;
    };
    const [wl, wd] = read('working'), [bl, bd] = read('background'), [ql, qd] = read('waiting'), [sl] = read('stopped');
    /* The dot is the circle after the masked logo; the mask has one of its own. */
    const circle = (svg) => (/<\/g><circle\b[^>]*>/.exec(svg) || [''])[0];
    eq([circle(wl).includes('fill="#388a34"'), circle(wd).includes('fill="#89d185"'), circle(bl).includes('stroke="#388a34"') && circle(bl).includes('fill="none"'),
      circle(bd).includes('stroke="#89d185"'), circle(ql).includes('fill="#e51400"'), circle(qd).includes('fill="#f14c4c"'), /<circle|mask/.test(sl)],
    [true, true, true, true, true, true, false],
    'on a logo the dot is green at work, a green ring with only background work, red waiting, and absent with the logo whole once stopped');
    eq([read('unread'), read('idle'), read('needs')], [null, null, null], 'the old state names are not drawn any more');
  }

  {
    const b = boot(root, tmp, { viewOptions: { listWaitMs: 40, slowMs: 300, refreshMs: 1e9, openWaitMs: 100, attentionMs: 100000 } });
    const { vscode, control } = b;
    const ws = tmp('ws');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws) }];
    const logo = path.join(tmp('logo'), 'l.svg');
    fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h4"/></svg>');
    b.api.registerSource({ protocol: 1, id: 'claude-code', label: 'Claude Code',
      listConversations: async () => [{ sessionId: 'c1', title: 'Claude', cwd: ws, state: 'working', activity: 'working', unseen: true }] });
    b.api.registerSource({ protocol: 1, id: 'codex', label: 'Codex', logo: { light: { fsPath: logo }, dark: { fsPath: logo } },
      listConversations: async () => [{ sessionId: 'x1', title: 'Codex', cwd: ws, state: 'idle', activity: 'background' }] });
    await wait(150);
    const conv = control.state.views['agentPlus.conversations'].provider;
    const rows = conv.getChildren().filter((e) => e.kind === 'conversation').map((e) => conv.getTreeItem(e));
    const claude = rows.find((r) => r.label === 'Claude'), codex = rows.find((r) => r.label === 'Codex');
    const provider = control.state.decorations[0];
    if (control.state.decorations.length === 1 && claude && codex && claude.resourceUri && !codex.resourceUri
      && provider.provideFileDecoration(claude.resourceUri).badge === ENVELOPE
      && /stroke=/.test(fs.readFileSync(codex.iconPath.light.fsPath, 'utf8'))) {
      ok('a running window registers the envelope badges, and draws a source\'s logo with the ring of its activity');
    } else bad(`rows ${JSON.stringify([control.state.decorations.length, rows])}`);
    b.close();
    eq(control.state.decorations.length, 0, 'closing the window takes the badges away');
  }
};
