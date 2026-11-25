// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * stewardOf() and onDidChangeStewards on the interface (src/host.js, src/sources.js): the steward that looks after a
 * conversation, asked of the sources registered in this window that list 'stewards'.
 */
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  /* A source that keeps stewards; its stewardOf() returns what `answer(sourceId, sessionId)` does. */
  const keeper = (id, answer, over = {}) => {
    const heard = new Set(), asked = [];
    const source = Object.assign({ protocol: 1, id, label: id, features: ['stewards'],
      stewardOf(sourceId, sessionId) { asked.push([sourceId, sessionId]); return answer(sourceId, sessionId); },
      onDidChangeStewards(fn) { heard.add(fn); return { dispose: () => { heard.delete(fn); } }; } }, over);
    return { source, asked, heard, fire: () => { for (const fn of [...heard]) fn(); } };
  };
  const CC = { sourceId: 'claude-code', sessionId: 'steward-1' };
  const turn = () => wait(5);

  /* ── Only a source that lists 'stewards' is asked ── */
  {
    const b = boot(root, tmp, { views: false });
    const api = b.api;
    eq([api.features.includes('stewards'), typeof api.stewardOf, typeof api.onDidChangeStewards], [true, 'function', 'function'],
      'the core lists \'stewards\' and has stewardOf() and onDidChangeStewards');
    eq(api.stewardOf('opencode-plus', 'ses_A'), null, 'with no source registered, stewardOf() is null');
    const unlisted = keeper('claude-code', () => CC, { features: ['brief'] });
    const r = api.registerSource(unlisted.source);
    eq([r.accepted, api.stewardOf('opencode-plus', 'ses_A'), unlisted.asked.length, unlisted.heard.size], [true, null, 0, 0],
      'a source that has stewardOf() but does not list \'stewards\' is neither asked nor listened to, and stewardOf() is null');
    b.close();
  }

  /* ── The two ways to call it, and ids it cannot use ── */
  {
    const b = boot(root, tmp, { views: false });
    const cc = keeper('claude-code', (s, id) => (s === 'opencode-plus' && id === 'ses_A' ? CC : null));
    b.api.registerSource(cc.source);
    const two = b.api.stewardOf('opencode-plus', 'ses_A'), one = b.api.stewardOf({ sourceId: 'opencode-plus', sessionId: 'ses_A' });
    eq([two, one, Object.isFrozen(two), Object.isFrozen(one), two !== CC, cc.asked], [CC, CC, true, true, true, [['opencode-plus', 'ses_A'], ['opencode-plus', 'ses_A']]],
      'stewardOf() takes the two ids or one { sourceId, sessionId }, passes them to the source as two, and returns a frozen copy of its answer');
    eq(b.api.stewardOf('opencode-plus', 'ses_B'), null, 'a conversation no steward looks after is null');
    const asked = cc.asked.length;
    const thrower = { get sourceId() { throw new Error('no'); }, sessionId: 'ses_A' };
    eq([b.api.stewardOf('opencode-plus', ''), b.api.stewardOf(' opencode-plus', 'ses_A'), b.api.stewardOf('opencode-plus', 42),
      b.api.stewardOf('opencode-plus', 'x'.repeat(201)), b.api.stewardOf('opencode-plus'), b.api.stewardOf({ sourceId: 'opencode-plus' }),
      b.api.stewardOf(thrower), b.api.stewardOf(null), b.api.stewardOf(), cc.asked.length - asked],
      [null, null, null, null, null, null, null, null, null, 0],
      'an id that is empty, padded, not a string or too long, a missing one, a getter that throws, or nothing at all: null, and no source is asked');
    b.close();
  }

  /* ── An answer of the wrong form, or a source that throws, counts as none ── */
  {
    const b = boot(root, tmp, { views: false });
    let answer = null;
    const cc = keeper('claude-code', () => (typeof answer === 'function' ? answer() : answer));
    b.api.registerSource(cc.source);
    const got = (a) => { answer = a; return b.api.stewardOf('opencode-plus', 'ses_A'); };
    const wrong = [
      { sourceId: 'claude-code' },
      { sessionId: 'steward-1' },
      { sourceId: 'claude-code', sessionId: '' },
      { sourceId: ' claude-code', sessionId: 'steward-1' },
      { sourceId: 'claude-code', sessionId: 'x'.repeat(201) },
      { sourceId: 'claude-code', sessionId: 7 },
      { sourceId: 'claude-code', sessionId: 'a\uD800' },
      { get sourceId() { throw new Error('getter'); }, sessionId: 'steward-1' },
      'claude-code:steward-1',
      Promise.resolve(CC),
      42,
      () => { throw new Error('no table'); },
    ];
    eq(wrong.map(got), Array(wrong.length).fill(null),
      'an id missing, empty, padded, too long, not a string or with a lone surrogate, a getter that throws, a string, a promise, a number, or a stewardOf() that throws: null');
    const extra = got(Object.assign({ title: 'Steward' }, CC));
    eq([extra, Object.keys(extra)], [CC, ['sourceId', 'sessionId']], 'other fields in an answer are left out of the result');
    b.close();
  }

  /* ── The sources are asked in the order they registered, and the first answer wins ── */
  {
    const b = boot(root, tmp, { views: false });
    const answers = { first: null, second: null };
    const first = keeper('first', () => answers.first), second = keeper('second', () => answers.second);
    const third = keeper('third', () => ({ sourceId: 'third', sessionId: 'T' }));
    const accepted = [
      b.api.registerSource({ protocol: 1, id: 'no-member', features: ['stewards'] }),
      b.api.registerSource({ protocol: 1, id: 'getter-throws', features: ['stewards'], get stewardOf() { throw new Error('x'); } }),
      b.api.registerSource(first.source), b.api.registerSource(second.source), b.api.registerSource(third.source),
    ].map((r) => r.accepted);
    const of = () => b.api.stewardOf('opencode-plus', 'ses_A');
    const results = [];
    results.push(of());
    answers.second = { sourceId: 'second', sessionId: 'S' };
    results.push(of());
    answers.first = { sourceId: 'first', sessionId: 'F' };
    results.push(of());
    answers.first = { sourceId: 'first' };
    results.push(of());
    eq([accepted, results, [first.asked.length, second.asked.length, third.asked.length]],
      [[true, true, true, true, true], [{ sourceId: 'third', sessionId: 'T' }, { sourceId: 'second', sessionId: 'S' }, { sourceId: 'first', sessionId: 'F' },
        { sourceId: 'second', sessionId: 'S' }], [4, 3, 1]],
      'a source with no stewardOf() or one that throws on reading it is passed over; the first source in registration order with a usable answer has it, and the ones after it are not asked');
    answers.first = answers.second = null;
    eq([b.api.stewardOf('claude-code', 'x'), third.asked[third.asked.length - 1]], [{ sourceId: 'third', sessionId: 'T' }, ['claude-code', 'x']],
      'a source is asked about a conversation of any source, not only its own');
    b.close();
  }

  /* ── onDidChangeStewards ── */
  {
    const b = boot(root, tmp, { views: false });
    let n = 0, seen = null;
    const self = {}, subs = [];
    const sub = b.api.onDidChangeStewards(function () { n++; seen = this; }, self, subs);
    let threw = '';
    try { b.api.onDidChangeStewards(42); } catch (e) { threw = e.constructor.name; }
    eq([typeof sub.dispose, subs.length === 1 && subs[0] === sub, threw], ['function', true, 'TypeError'],
      'onDidChangeStewards returns a Disposable, adds it to the array it is given, and refuses a listener that is not a function');

    const plain = b.api.registerSource({ protocol: 1, id: 'plain' });
    await turn();
    eq(n, 0, 'a source that does not list \'stewards\' registering fires nothing');

    const cc = keeper('claude-code', () => CC);
    const reg = b.api.registerSource(cc.source);
    eq([n, cc.heard.size], [0, 1], 'a source that lists it is listened to as it registers, and the event waits for the end of the turn');
    await turn();
    eq([n, seen === self], [1, true], 'that source registering fires the event once, with the thisArgs given');

    cc.fire(); cc.fire(); cc.fire();
    await turn();
    eq(n, 2, 'the source reporting three changes in one turn fires the event once');

    const oc = keeper('opencode-plus', () => null);
    b.api.registerSource(oc.source);
    cc.fire();
    await turn();
    eq(n, 3, 'another source that lists it registering and a change reported in the same turn fire it once');

    const odd = [
      b.api.registerSource({ protocol: 1, id: 'no-event', features: ['stewards'], stewardOf: () => null }),
      b.api.registerSource({ protocol: 1, id: 'event-throws', features: ['stewards'], stewardOf: () => null, onDidChangeStewards() { throw new Error('x'); } }),
    ];
    await turn();
    eq([odd.map((r) => r.accepted), n], [[true, true], 4], 'a source that lists it with no onDidChangeStewards, or one that throws, is still taken, and its registering fires the event');

    plain.registration.dispose();
    await turn();
    eq(n, 4, 'a source that does not list it going away fires nothing');

    const kept = [...cc.heard];
    const before = b.api.stewardOf('opencode-plus', 'ses_A');
    reg.registration.dispose();
    eq([before, cc.heard.size, b.api.stewardOf('opencode-plus', 'ses_A')], [CC, 0, null], 'a source going away is no longer listened to, and its answer is gone with it');
    await turn();
    eq(n, 5, 'a source that lists it going away fires the event once');
    for (const fn of kept) fn();
    await turn();
    eq(n, 5, 'a change reported through a listener the source failed to drop, after it has gone, fires nothing');

    sub.dispose();
    oc.fire();
    await turn();
    eq(n, 5, 'a disposed listener hears nothing more');

    let m = 0;
    b.api.onDidChangeStewards(() => m++);
    oc.fire();
    b.close();
    await turn();
    eq([m, b.api.stewardOf('opencode-plus', 'ses_A')], [0, null], 'a change reported as the window closes fires nothing, and a closed window answers null');
  }

  /* ── Restricted Mode, with the views built ── */
  {
    const b = boot(root, tmp, { trusted: false });
    let n = 0;
    b.api.onDidChangeStewards(() => n++);
    const cc = keeper('claude-code', () => CC, { listConversations: async () => [] });
    b.api.registerSource(cc.source);
    await turn();
    const before = n;
    eq([before, b.api.stewardOf('opencode-plus', 'ses_A'), b.api.stewardOf({ sourceId: 'opencode-plus', sessionId: 'ses_A' }), cc.asked.length],
      [1, null, null, 0], 'in Restricted Mode stewardOf() is null and no source is asked');
    b.control.grantTrust();
    await turn();
    eq([n - before, b.api.stewardOf('opencode-plus', 'ses_A')], [1, CC], 'trusting the workspace fires the event once, and stewardOf() answers from then on');
    b.close();
  }
  {
    const b = boot(root, tmp, { trusted: false, views: false });
    let n = 0;
    b.api.onDidChangeStewards(() => n++);
    b.api.registerSource({ protocol: 1, id: 'plain' });
    b.control.grantTrust();
    await turn();
    eq(n, 0, 'trusting the workspace with no source that lists \'stewards\' fires nothing');
    b.close();
  }
};
