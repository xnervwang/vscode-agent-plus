// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * src/sources.js: what a source must have to register, how its members are read, and which conversation is in front.
 * Adapted from the "source registry" checks in vscode-claude-code-extras' test/check.js.
 */
const path = require('path');

module.exports = async ({ ok, bad, eq, root }) => {
  const src = require(path.join(root, 'src', 'sources.js'));
  const S = (over) => Object.assign({ protocol: 1, features: [], id: 'codex', label: 'Codex' }, over);

  eq([src.verdict(1, [1]), src.verdict(2, [1]), src.verdict(1, [3, 2]), src.verdict(2, [3, 2]), src.verdict('1', [1]), src.verdict(0, [1])],
    ['', 'core-too-old', 'source-too-old', '', 'shape', 'shape'], 'verdict() says which side is behind');
  const refused = [S({ protocol: 2 }), S({ protocol: '1' }), S({ protocol: undefined }), S({ id: '' }), S({ id: ' x' }), null, 'codex']
    .map((x) => src.refusal(x).code);
  eq(refused, ['core-too-old', 'shape', 'shape', 'id', 'id', 'shape', 'shape'], 'refusal() names the reason with a code');
  eq(src.refusal(S()).code, '', 'a source with protocol 1 and an id is accepted');

  const reg = new src.Registry();
  const heard = [];
  reg.onDidChange((e) => heard.push(e.added ? { added: e.added } : { removed: e.removed }));
  const a = reg.add(S()), dup = reg.add(S({ label: 'again' })), old = reg.add(S({ id: 'older', protocol: 3 }));
  const b = reg.add(S({ id: 'claude-code', label: 'Claude Code' }));
  const order = reg.all().map((x) => x.id).join();
  a.remove(); a.remove();
  if (a.ok && !dup.ok && dup.code === 'duplicate' && !old.ok && old.code === 'core-too-old' && b.ok && order === 'codex,claude-code') {
    ok('the registry rejects a duplicate id and a protocol it does not accept');
  } else bad(`registry: ${JSON.stringify([a.ok, dup, old, b.ok, order])}`);
  eq([reg.size, reg.get('codex'), heard], [1, null, [{ added: 'codex' }, { added: 'claude-code' }, { removed: 'codex' }]],
    'removing a registration twice fires one event');

  let called = 0;
  const unlisted = S({ preview: () => ++called }), listed = S({ features: ['preview'], preview: () => ++called });
  const none = src.optional(unlisted, 'preview'), some = src.optional(listed, 'preview');
  if (none === null && typeof some === 'function' && some() === 1 && called === 1 && !src.supports(S({ features: 'preview' }), 'preview')) {
    ok('members added later are called only when listed in features');
  } else bad('feature gate');

  const c = src.conversation({ sessionId: 't1', title: 'T', cwd: '/w', state: 'thinking', running: undefined,
    lastActiveAt: '2026-11-07T12:00:00Z', hasPlan: 'yes', colour: 'red', id: 'x', kind: 'y' });
  const needs = src.conversation({ sessionId: 't2', state: 'needs', running: false, lastActiveAt: -5 });
  eq(c && Object.keys(c).sort(), ['cwd', 'hasPlan', 'lastActiveAt', 'running', 'sessionId', 'state', 'title'], 'conversation() keeps only the protocol\'s fields');
  eq([c.state, c.running, c.lastActiveAt, c.hasPlan, needs.state, needs.running, needs.lastActiveAt],
    ['idle', true, Date.UTC(2026, 10, 7, 12), false, 'idle', false, 0], 'and reads unknown states as idle, running by default');
  eq([src.conversation({ title: 'no id' }), src.conversation(null), src.STATES.every((st) => src.conversation({ sessionId: 'x', state: st }).state === st)],
    [null, null, true], 'a conversation without a usable id is dropped');
  eq(src.conversations(Array.from({ length: src.MAX_CONVERSATIONS + 5 }, (_, i) => ({ sessionId: 's' + i }))).length, src.MAX_CONVERSATIONS,
    'a list is cut at MAX_CONVERSATIONS');

  const bare = S();
  const thrower = Object.defineProperty(S({ planPath() { throw new Error('x'); }, planDir: () => 42, onDidFocus() { throw new Error('y'); },
    planNotice() { throw new Error('n'); }, timeZone: () => 'not a zone!' }), 'label', { get() { throw new Error('z'); } });
  if (src.planFileOf(bare, 's') === '' && src.planFileOf(thrower, 's') === '' && src.planDirOf(thrower) === ''
    && src.listen(bare, 'onDidFocus', () => {}) === null && src.listen(thrower, 'onDidFocus', () => {}) === null
    && src.call(bare, 'reveal', ['s'], 'none') === 'none' && src.labelOf(thrower) === 'codex' && src.noticeOf(thrower) === null
    && src.timeZoneOf(thrower) === '' && src.logoOf(bare) === null
    && JSON.stringify(src.logoOf(S({ logo: { light: { fsPath: '/l.svg' } } }))) === '{"light":"/l.svg","dark":"/l.svg"}') {
    ok('missing or throwing source members give the fallback');
  } else bad('a bare or throwing source was not tolerated');
  eq([src.extensionOf(S({ extensionId: 'xnervwang.codex-plus' })), src.extensionOf(S({ extensionId: 'no' })), src.timeZoneOf(S({ timeZone: () => 'America/Los_Angeles' }))],
    ['xnervwang.codex-plus', '', 'America/Los_Angeles'], 'extensionId and timeZone are read when well formed');
  eq(src.noticeOf(S({ planNotice: () => ({ title: '  Install it ', command: 'x.y', arguments: [1], description: 'click' }) })),
    { title: 'Install it', description: 'click', detail: '', command: 'x.y', arguments: [1] }, 'planNotice() is read into a fixed shape');

  /* Three answers from sessionForTab(): an id, '' for "mine with no conversation yet", anything else for "not mine". */
  const tabA = { label: 'a' }, tabB = { label: 'b' }, fresh = { label: 'new' }, file = { label: 'file' };
  const claude = S({ id: 'claude-code', sessionForTab: (t) => (t === tabA ? 'A' : null) });
  const codex = S({ sessionForTab: (t) => (t === tabB ? 'B' : t === fresh ? '' : undefined) });
  const broken = S({ id: 'broken', sessionForTab() { throw new Error('no'); } });
  const f = new src.Focus();
  const steps = [];
  const at = () => f.sourceId + '/' + f.sessionId;
  const E = (...list) => list.map((source) => ({ id: source.id, source }));
  steps.push([f.claim(tabA, E(broken, claude, codex)), at()]);
  steps.push([f.claim(file, E(broken, claude, codex)), at()]);
  steps.push([f.claim(tabB, E(broken, claude, codex)), at()]);
  steps.push([f.claim(fresh, E(claude, codex)), at()]);
  steps.push([f.claim(file, E(claude, codex)), at()]);
  steps.push([f.report('claude-code', 'A2'), at()]);
  steps.push([f.claim(tabB, E(claude, codex)), at()]);
  steps.push([f.report('claude-code', ''), at()]);
  steps.push([f.report('codex', ''), at()]);
  steps.push([f.drop('codex'), at()]);
  eq(steps, [[true, 'claude-code/A'], [false, 'claude-code/A'], [true, 'codex/B'], [true, 'codex/'], [false, 'codex/'],
    [true, 'claude-code/A2'], [true, 'codex/B'], [false, 'codex/B'], [true, 'codex/'], [true, '/']],
  'the front conversation follows claimed tabs and reports; a new tab of a source shows nothing, a file keeps the last');

  const ev = src.emitter(), got = [];
  const d = ev.event((v) => got.push(v));
  ev.event(() => { throw new Error('one listener failing'); });
  ev.fire(1); d.dispose(); ev.fire(2);
  eq(got, [1], 'emitter() keeps calling listeners after one throws');
};
