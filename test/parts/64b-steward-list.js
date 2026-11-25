// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * stewardsOf() on the interface (src/host.js, src/sources.js): every steward that looks after a conversation, and
 * onDidChangeStewards for a source that lists only 'stewardList'.
 */
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  /* A stand-in source that lists 'stewardList': its stewardsOf() records each call and returns answer(sourceId, sessionId). */
  const keeper = (id, answer, over = {}) => {
    const heard = new Set(), asked = [];
    const source = Object.assign({ protocol: 1, id, label: id, features: ['stewardList'],
      stewardsOf(sourceId, sessionId) { asked.push([sourceId, sessionId]); return answer(sourceId, sessionId); },
      onDidChangeStewards(fn) { heard.add(fn); return { dispose: () => { heard.delete(fn); } }; } }, over);
    return { source, asked, heard, fire: () => { for (const fn of [...heard]) fn(); } };
  };
  const S = (sessionId, title = '', sourceId = 'claude-code') => ({ sourceId, sessionId, title });
  const turn = () => wait(5);
  const frozen = (list) => Object.isFrozen(list) && list.every((s) => Object.isFrozen(s));

  /* ── Only a source that lists 'stewardList' is asked ── */
  {
    const b = boot(root, tmp, { views: false });
    const api = b.api;
    const none = api.stewardsOf('opencode-plus', 'ses_A');
    eq([api.features.includes('stewardList'), typeof api.stewardsOf, none, Object.isFrozen(none)], [true, 'function', [], true],
      'the core lists \'stewardList\' and has stewardsOf(), which with no source registered is a frozen empty array');
    const unlisted = keeper('claude-code', () => [S('a')], { features: ['stewards'] });
    b.api.registerSource(unlisted.source);
    eq([api.stewardsOf('opencode-plus', 'ses_A'), unlisted.asked.length], [[], 0],
      'a source that has stewardsOf() but does not list \'stewardList\' is not asked');
    b.close();
  }

  /* ── Called with two ids or with one object, and with ids it cannot use ── */
  {
    const b = boot(root, tmp, { views: false });
    const cc = keeper('claude-code', (s, id) => (s === 'opencode-plus' && id === 'ses_A' ? [S('a', 'Steward A'), S('b', 'Steward B')] : []));
    b.api.registerSource(cc.source);
    const two = b.api.stewardsOf('opencode-plus', 'ses_A'), one = b.api.stewardsOf({ sourceId: 'opencode-plus', sessionId: 'ses_A' });
    eq([two, one, frozen(two), frozen(one), cc.asked], [[S('a', 'Steward A'), S('b', 'Steward B')], [S('a', 'Steward A'), S('b', 'Steward B')], true, true,
      [['opencode-plus', 'ses_A'], ['opencode-plus', 'ses_A']]],
      'stewardsOf() takes the two ids or one { sourceId, sessionId }, passes them to the source as two, and returns frozen copies in the source\'s order');
    eq(b.api.stewardsOf('opencode-plus', 'ses_B'), [], 'a conversation no steward looks after has none');
    const asked = cc.asked.length;
    eq([b.api.stewardsOf('opencode-plus', ''), b.api.stewardsOf(' opencode-plus', 'ses_A'), b.api.stewardsOf('opencode-plus', 42),
      b.api.stewardsOf('opencode-plus'), b.api.stewardsOf({ sourceId: 'opencode-plus' }), b.api.stewardsOf(null), b.api.stewardsOf(),
      cc.asked.length - asked], [[], [], [], [], [], [], [], 0],
      'an id that is empty, padded, not a string or missing, or nothing at all: none, and no source is asked');
    b.close();
  }

  /* ── An entry of the wrong form is left out, an answer of the wrong form counts as none ── */
  {
    const b = boot(root, tmp, { views: false });
    let answer = null;
    const cc = keeper('claude-code', () => (typeof answer === 'function' ? answer() : answer));
    b.api.registerSource(cc.source);
    const got = (a) => { answer = a; return b.api.stewardsOf('opencode-plus', 'ses_A'); };
    const wrongAnswers = [null, S('a'), 'claude-code:a', 42, Promise.resolve([S('a')]), () => { throw new Error('no table'); },
      () => new Proxy([], { get(t, k) { if (k === 'length') throw new Error('length'); return t[k]; } })];
    eq(wrongAnswers.map(got), Array(wrongAnswers.length).fill([]),
      'an answer that is null, one entry, a string, a number, a promise, a stewardsOf() that throws or an array whose length throws: none');
    const mixed = got([
      S('kept-1', 'First'),
      { sessionId: 'no-source' },
      { sourceId: 'claude-code' },
      S(''),
      S(' padded'),
      S('x'.repeat(201)),
      S('a\uD800'),
      { get sourceId() { throw new Error('getter'); }, sessionId: 'thrower' },
      'claude-code:str',
      null,
      7,
      S('kept-2', '  Second  '),
      Object.assign(S('kept-3', 'Third'), { at: 5, extra: 'x' }),
      { sourceId: 'claude-code', sessionId: 'kept-4', title: 42 },
      S('kept-5', 'y'.repeat(300)),
    ]);
    eq(mixed.map((s) => [s.sessionId, s.title.length > 20 ? s.title.length : s.title, Object.keys(s)]),
      [['kept-1', 'First', ['sourceId', 'sessionId', 'title']], ['kept-2', 'Second', ['sourceId', 'sessionId', 'title']],
        ['kept-3', 'Third', ['sourceId', 'sessionId', 'title']], ['kept-4', '', ['sourceId', 'sessionId', 'title']],
        ['kept-5', 200, ['sourceId', 'sessionId', 'title']]],
      'entries missing an id or with an empty, padded, too long or broken one, a throwing getter, or not an object are left out and the rest kept; '
        + 'a title is trimmed and cut to 200 characters, one that is not a string is empty, and other fields are dropped');
    const long = got(Array.from({ length: 30 }, (_, i) => S(`s${i}`)));
    eq([long.length, long[19].sessionId], [20, 's19'], 'at most 20 stewards are given');
    b.close();
  }

  /* ── Several sources: joined in the order they registered ── */
  {
    const b = boot(root, tmp, { views: false });
    const first = keeper('first', () => [S('a', 'A', 'first'), S('shared', 'Shared from first', 'claude-code')]);
    const second = keeper('second', () => [S('shared', 'Shared from second', 'claude-code'), S('b', 'B', 'second')]);
    const quiet = keeper('quiet', () => []);
    const accepted = [
      b.api.registerSource({ protocol: 1, id: 'no-member', features: ['stewardList'] }),
      b.api.registerSource({ protocol: 1, id: 'getter-throws', features: ['stewardList'], get stewardsOf() { throw new Error('x'); } }),
      b.api.registerSource(quiet.source), b.api.registerSource(first.source), b.api.registerSource(second.source),
    ].map((r) => r.accepted);
    eq([accepted, b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => [s.sourceId, s.sessionId, s.title])],
      [[true, true, true, true, true], [['first', 'a', 'A'], ['claude-code', 'shared', 'Shared from first'], ['second', 'b', 'B']]],
      'a source with no stewardsOf() or one that throws on reading it is passed over; the lists are joined in registration order, a steward named twice kept where it first appears');
    eq([b.api.stewardsOf('claude-code', 'x').length, second.asked[second.asked.length - 1]], [3, ['claude-code', 'x']],
      'a source is asked about a conversation of any source, not only its own');
    const many = keeper('many', () => Array.from({ length: 19 }, (_, i) => S(`m${i}`, '', 'many')));
    b.api.registerSource(many.source);
    const all = b.api.stewardsOf('opencode-plus', 'ses_A');
    eq([all.length, all[all.length - 1].sessionId], [20, 'm16'], 'joined, they are cut at 20 too');
    b.close();
  }

  /* ── onDidChangeStewards for a source that lists only 'stewardList' ── */
  {
    const b = boot(root, tmp, { views: false });
    let n = 0;
    b.api.onDidChangeStewards(() => n++);
    const cc = keeper('claude-code', () => [S('a')]);
    const reg = b.api.registerSource(cc.source);
    eq([n, cc.heard.size], [0, 1], 'a source that lists only \'stewardList\' is listened to as it registers');
    await turn();
    eq(n, 1, 'and its registering fires the event once');
    cc.fire(); cc.fire();
    await turn();
    eq(n, 2, 'two changes it reports in one turn fire the event once');
    const both = keeper('both', () => [S('b')], { features: ['stewards', 'stewardList'], stewardOf: () => S('b') });
    b.api.registerSource(both.source);
    await turn();
    eq([n, both.heard.size], [3, 1], 'a source that lists both is listened to once');
    reg.registration.dispose();
    eq([cc.heard.size, b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => s.sessionId)], [0, ['b']],
      'a source going away is no longer listened to, and its stewards are gone with it');
    await turn();
    eq(n, 4, 'and its going away fires the event once');
    b.close();
    await turn();
    eq(b.api.stewardsOf('opencode-plus', 'ses_A'), [], 'a closed window has no stewards');
  }

  /* ── Restricted Mode ── */
  {
    const b = boot(root, tmp, { trusted: false, views: false });
    let n = 0;
    b.api.onDidChangeStewards(() => n++);
    const cc = keeper('claude-code', () => [S('a')]);
    b.api.registerSource(cc.source);
    await turn();
    const before = n;
    eq([before, b.api.stewardsOf('opencode-plus', 'ses_A'), cc.asked.length], [1, [], 0], 'in Restricted Mode stewardsOf() is empty and no source is asked');
    b.control.grantTrust();
    await turn();
    eq([n - before, b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => s.sessionId)], [1, ['a']],
      'trusting the workspace fires the event once, and stewardsOf() answers from then on');
    b.close();
  }
};
