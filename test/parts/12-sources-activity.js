// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The three fields a conversation can carry besides `state` (src/sources.js): `activity`, `unseen` and `lastUserAt`.
 * Each is read when a source gives it in a usable form; otherwise `activity` and `unseen` are worked out from `state`.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const src = require(path.join(root, 'src', 'sources.js'));
  const c = (o) => src.conversation(Object.assign({ sessionId: 's' }, o));
  const pick = (x) => [x.activity, x.unseen, x.lastUserAt];

  eq(['prompt', 'working', 'unread', 'idle', 'mystery'].map((state) => pick(c({ state }))),
    [['waiting', false, 0], ['working', false, 0], ['stopped', true, 0], ['stopped', false, 0], ['stopped', false, 0]],
    'without the new fields, activity and unseen follow state: prompt waits, working works, unread and idle have stopped');
  eq(['working', 'background', 'waiting', 'stopped'].map((activity) => c({ state: 'idle', activity }).activity),
    ['working', 'background', 'waiting', 'stopped'], 'an activity the protocol names is kept, whatever state says');
  eq([c({ state: 'prompt', activity: 'busy' }).activity, c({ state: 'working', activity: 7 }).activity, c({ state: 'unread', activity: null }).activity],
    ['waiting', 'working', 'stopped'], 'any other activity reads as not given');
  eq([c({ state: 'working', activity: 'working', unseen: true }), c({ state: 'unread', unseen: false }), c({ state: 'unread', unseen: 'yes' }),
    c({ state: 'idle', unseen: 1 })].map((x) => [x.activity, x.unseen]),
  [['working', true], ['stopped', false], ['stopped', true], ['stopped', false]],
  'unseen is read apart from activity, so a conversation at work can have a reply not seen; a value that is not a boolean reads as not given');
  eq([c({ lastUserAt: 1763700000000 }).lastUserAt, c({ lastUserAt: '2026-11-21T10:00:00Z' }).lastUserAt, c({ lastUserAt: 'soon' }).lastUserAt,
    c({ lastUserAt: -1 }).lastUserAt, c({ lastUserAt: Infinity }).lastUserAt, c({ lastUserAt: true }).lastUserAt],
  [1763700000000, Date.UTC(2026, 10, 21, 10), 0, 0, 0, 0], 'lastUserAt is read in milliseconds or as a date string, and is 0 when not usable');
  eq([c({ state: 'prompt', activity: 'stopped' }).state, c({ state: 'unread', unseen: false }).state], ['prompt', 'unread'],
    'state is read as before, whatever the new fields say');
  eq(src.ACTIVITIES, ['working', 'background', 'waiting', 'stopped'], 'the activities are exported for the other modules');
  eq([c({ title: '多对话管家 \u{1F6CE}\uFE0F', steward: true }), c({ title: '\u{1F451} \u{1F451} Steward \u2709\uFE0F', steward: true }),
    c({ title: 'Plain \u2709\uFE0E' }), c({ title: '\u{1F451} Not one' }), c({ title: 'Old \u{1F6CE}', steward: 'yes' })].map((x) => [x.title, x.steward]),
  [['多对话管家 \u{1F451}', true], ['Steward \u{1F451}', true], ['Plain', false], ['Not one', false], ['Old', false]],
  'every crown, envelope and old bell is taken out of a title, and a steward\'s title gets one crown after it; steward is true only when the source gives true');
};
