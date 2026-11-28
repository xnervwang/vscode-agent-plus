// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * stewardsOf() on the interface (src/host.js, src/sources.js): every steward that looks after a conversation, its lead
 * first and marked, and onDidChangeStewards for a source that lists only 'stewardList'.
 */
const { boot } = require('../boot');

module.exports = async ({ eq, tmp, root, wait }) => {
  /* A stand-in source that lists 'stewardList'; `over` replaces any of its members. */
  const keeper = (id, answer, over = {}) => {
    const heard = new Set(), asked = [];
    const source = Object.assign({ protocol: 1, id, label: id, features: ['stewardList'],
      stewardsOf(sourceId, sessionId) { asked.push([sourceId, sessionId]); return answer(sourceId, sessionId); },
      onDidChangeStewards(fn) { heard.add(fn); return { dispose: () => { heard.delete(fn); } }; } }, over);
    return { source, asked, heard, fire: () => { for (const fn of [...heard]) fn(); } };
  };
  const S = (sessionId, title = '', sourceId = 'claude-code', open = false, lead = false) => ({ sourceId, sessionId, title, open, lead });
  /* A steward the source marks as the conversation's lead. */
  const L = (sessionId, title = '', sourceId = 'claude-code') => S(sessionId, title, sourceId, false, true);
  const turn = () => wait(5);
  const frozen = (list) => Object.isFrozen(list) && list.every((s) => Object.isFrozen(s));
  const KEYS = ['sourceId', 'sessionId', 'title', 'open', 'lead'];

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
      'whether stewardsOf() is given two ids or one { sourceId, sessionId }, the answer comes back as frozen copies in the source\'s order');
    eq(b.api.stewardsOf('opencode-plus', 'ses_B'), [], 'a conversation the source has no stewards for gets an empty array');
    const asked = cc.asked.length;
    eq([b.api.stewardsOf('opencode-plus', ''), b.api.stewardsOf(' opencode-plus', 'ses_A'), b.api.stewardsOf('opencode-plus', 42),
      b.api.stewardsOf('opencode-plus'), b.api.stewardsOf({ sourceId: 'opencode-plus' }), b.api.stewardsOf(null), b.api.stewardsOf(),
      cc.asked.length - asked], [[], [], [], [], [], [], [], 0],
      'ids it cannot use give an empty array, and no source is asked');
    b.close();
  }

  /* ── Answers and entries of the wrong form ── */
  {
    const b = boot(root, tmp, { views: false });
    let answer = null;
    const cc = keeper('claude-code', () => (typeof answer === 'function' ? answer() : answer));
    b.api.registerSource(cc.source);
    const got = (a) => { answer = a; return b.api.stewardsOf('opencode-plus', 'ses_A'); };
    const wrongAnswers = [null, S('a'), 'claude-code:a', 42, Promise.resolve([S('a')]), () => { throw new Error('no table'); },
      () => new Proxy([], { get(t, k) { if (k === 'length') throw new Error('length'); return t[k]; } })];
    eq(wrongAnswers.map(got), Array(wrongAnswers.length).fill([]),
      'a non-array, a stewardsOf() that throws and an array whose length throws all give none');
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
      [['kept-1', 'First', KEYS], ['kept-2', 'Second', KEYS], ['kept-3', 'Third', KEYS], ['kept-4', '', KEYS], ['kept-5', 200, KEYS]],
      'entries without two usable ids, with a getter that throws, or that are not objects are left out and the rest kept; '
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
      'a source with no stewardsOf(), or whose stewardsOf() throws when read, is passed over; the other lists are joined in registration order, and a steward in two lists stays at its first place');
    eq([b.api.stewardsOf('claude-code', 'x').length, second.asked[second.asked.length - 1]], [3, ['claude-code', 'x']],
      'a source is asked about a conversation of any source, not only its own');
    const many = keeper('many', () => Array.from({ length: 19 }, (_, i) => S(`m${i}`, '', 'many')));
    b.api.registerSource(many.source);
    const all = b.api.stewardsOf('opencode-plus', 'ses_A');
    eq([all.length, all[all.length - 1].sessionId], [20, 'm16'], 'joined, they are cut at 20 too');
    b.close();
  }

  /* ── The lead ── */
  {
    const b = boot(root, tmp, { views: false });
    let answer = [];
    const cc = keeper('claude-code', () => answer);
    b.api.registerSource(cc.source);
    const got = (a) => { answer = a; return b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => [s.sessionId, s.lead]); };
    eq(b.api.features.includes('stewardLead'), true, 'the core lists \'stewardLead\'');
    answer = [S('a', 'Observer A'), S('b', 'Observer B'), L('c', 'Lead C')];
    const whole = b.api.stewardsOf('opencode-plus', 'ses_A');
    eq([whole, frozen(whole), whole.map((s) => Object.keys(s))], [[L('c', 'Lead C'), S('a', 'Observer A'), S('b', 'Observer B')], true, [KEYS, KEYS, KEYS]],
      'a lead the source lists last comes back first with lead true, and the others keep the source\'s order with lead false');
    eq(got([S('a'), S('b'), S('c')]), [['a', false], ['b', false], ['c', false]],
      'a list with no entry marked keeps its order and has no lead');
    eq(got([S('a'), L('b'), L('c')]), [['b', true], ['a', false], ['c', false]],
      'when one source marks two entries, the first is the lead and the second an ordinary entry');
    eq(got([S('a'), Object.assign(S('b'), { lead: 'true' }), Object.assign(S('c'), { lead: 1 }),
      { sourceId: 'claude-code', sessionId: 'd', get lead() { throw new Error('getter'); } }]),
    [['a', false], ['b', false], ['c', false], ['d', false]],
    'a lead that is a string, a number or a getter that throws is not a lead, and its entry is kept');
    eq(got([S('a'), L('b'), S('b', 'Again'), S('c')]), [['b', true], ['a', false], ['c', false]],
      'the lead listed again unmarked comes back once');
    eq(got([S('a'), { sourceId: 'claude-code', sessionId: '', lead: true }, L('b')]), [['b', true], ['a', false]],
      'a marked entry without two usable ids is skipped, and a later mark makes the lead');
    const long = got(Array.from({ length: 30 }, (_, i) => S(`s${i}`)).concat(L('last')));
    eq([long.length, long[0], long[1], long[19]], [20, ['last', true], ['s0', false], ['s18', false]],
      'a lead after the 20th entry is kept and comes first, and the cut drops the last of the others instead');
    eq(got(Array.from({ length: 200 }, (_, i) => S(`s${i}`)).concat(L('too-far'))).map((s) => s[0]).includes('too-far'), false,
      'a lead after the first 200 entries of an answer is not read');
    b.close();
  }

  /* ── Several sources and their leads ── */
  {
    const b = boot(root, tmp, { views: false });
    const answers = { first: [], second: [] };
    const first = keeper('first', () => answers.first), second = keeper('second', () => answers.second);
    b.api.registerSource(first.source);
    b.api.registerSource(second.source);
    const got = () => b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => [s.sessionId, s.title, s.lead]);

    answers.first = [S('a', 'A'), S('b', 'B')];
    answers.second = [S('c', 'C'), L('d', 'D')];
    eq(got(), [['d', 'D', true], ['a', 'A', false], ['b', 'B', false], ['c', 'C', false]],
      'a lead only the later source marks comes first, ahead of the earlier source\'s stewards');

    /* Each source names a different lead. The core keeps the lead of the source registered first; the other source's
       lead stays in the list as one of the others. */
    answers.first = [S('a', 'A'), L('b', 'B')];
    answers.second = [L('c', 'C'), S('d', 'D')];
    eq(got(), [['b', 'B', true], ['a', 'A', false], ['c', 'C', false], ['d', 'D', false]],
      'with two sources each naming a lead, the first source\'s lead is the lead, and the second\'s is listed after the first source\'s other stewards with lead false');

    answers.first = [S('a', 'A'), S('shared', 'Shared from first')];
    answers.second = [L('shared', 'Shared from second'), S('c', 'C')];
    eq(got(), [['shared', 'Shared from first', true], ['a', 'A', false], ['c', 'C', false]],
      'marked only by the later source, the lead still comes first, once, with the title the earlier source gave it');

    answers.first = [L('shared', 'Shared from first'), S('a', 'A')];
    answers.second = [S('shared', 'Shared from second'), S('c', 'C')];
    eq(got(), [['shared', 'Shared from first', true], ['a', 'A', false], ['c', 'C', false]],
      'marked only by the earlier source, it also comes back once');

    answers.first = Array.from({ length: 20 }, (_, i) => S(`f${i}`));
    answers.second = [L('lead', 'Lead')];
    const cut = got();
    eq([cut.length, cut[0], cut[1][0], cut[19][0]], [20, ['lead', 'Lead', true], 'f0', 'f18'],
      'when the earlier source fills the 20 places, the later source\'s lead still comes first and the last ordinary entry is dropped');

    answers.first = [L('lead', 'Lead')].concat(Array.from({ length: 19 }, (_, i) => S(`f${i}`)));
    const asked = second.asked.length;
    eq([got().length, second.asked.length - asked], [20, 0], 'once a lead is known and 20 stewards are in, the sources after are not asked');
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
    eq(n, 1, 'and registering it fires the event once');
    cc.fire(); cc.fire();
    await turn();
    eq(n, 2, 'two changes it reports in one turn fire the event once');
    const both = keeper('both', () => [S('b')], { features: ['stewards', 'stewardList'], stewardOf: () => S('b') });
    b.api.registerSource(both.source);
    await turn();
    eq([n, both.heard.size], [3, 1], 'a source listing both features gets one listener');
    reg.registration.dispose();
    eq([cc.heard.size, b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => s.sessionId)], [0, ['b']],
      'a source that goes away stops being listened to, and its stewards go with it');
    await turn();
    eq(n, 4, 'and that fires the event once more');
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

  /* ── open: whether a window on this machine shows the supervisor's conversation ── */
  {
    const fs = require('fs'), path = require('path');
    const b = boot(root, tmp, { views: false });
    const plans = tmp('steward-open-plans');
    fs.mkdirSync(path.join(plans, 'windows'), { recursive: true });
    const cc = keeper('claude-code', () => [S('shown', 'Shown'), S('closed', 'Closed')], { planDir: () => plans });
    b.api.registerSource(cc.source);
    fs.writeFileSync(path.join(plans, 'windows', `${process.pid}.json`), JSON.stringify({ at: Date.now(), name: 'w', sessions: ['shown'] }));
    eq(b.api.stewardsOf('opencode-plus', 'ses_A').map((s) => [s.sessionId, s.open]), [['shown', true], ['closed', false]],
      "open for each supervisor, this window's entry counting like any other");
    b.close();
  }
};
