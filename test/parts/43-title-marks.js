// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The marks drawn with a conversation's title (src/title-marks.js): stripped wherever they stand, then shown with one
 * hourglass first for a temporary conversation, one crown for a steward and one envelope last for a reply not read.
 */
const path = require('path');

module.exports = async ({ eq, root }) => {
  const tm = require(path.join(root, 'src', 'title-marks.js'));
  const env = require(path.join(root, 'src', 'envelope.js'));
  const C = '\u{1F451}', E = env.COLOUR, T = env.TEXT, BELL = '\u{1F6CE}\uFE0F', BELL0 = '\u{1F6CE}';
  const typed = ['Title', C + ' Title', C + ' ' + C + ' Title', 'Ti ' + C + ' tle', 'Title ' + C, 'Title ' + BELL, 'Title ' + BELL0,
    C + ' Title ' + BELL, 'Title ' + E, E + ' Title ' + E + E, C + ' Title ' + E, '  ' + C + 'Title' + E + '  ', 'Title ' + T, 'Ti ' + T + ' tle \u2709',
    '  Fix   the' + E + 'build  ', 'Title \u2709\uFE0F', 'Title \u2709\uFE0E', C + ' Title \u2709\uFE0F'];
  const want = ['Title', 'Title', 'Title', 'Ti tle', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Title', 'Ti tle',
    'Fix the build', 'Title', 'Title', 'Title'];
  eq(typed.map(tm.withoutMarks), want, 'every crown, envelope and bell is taken off wherever it stands, the plain envelope of earlier builds in both its forms included,, and the runs of spaces left are closed up');
  eq(typed.map((t) => tm.withMarks(t, { steward: true, unseen: true })), want.map((w) => `${w} ${C} ${E}`), 'and a steward with a reply not read is shown with one crown after the title and one envelope last');
  eq(typed.map((t) => tm.withMarks(t, {})), want, 'and with no mark at all otherwise');
  eq([tm.withoutMarks(''), tm.withMarks(C, { steward: true }), tm.withEnvelope('Fix ' + E + ' it', true), tm.withEnvelope('Fix it ' + E, false),
    tm.withEnvelope('Fix it', true, T), tm.withoutEnvelope(C + ' Fix ' + T)],
  ['', C, 'Fix it ' + E, 'Fix it', 'Fix it ' + T, C + ' Fix'],
  'the envelope part works on its own, for an agent with no steward, and draws the form it is given');
  eq(tm.ENVELOPE, E, 'the envelope it draws by default is the colour form src/envelope.js gives a dark theme');
  const H = '\u23F3';
  eq([H + ' Title', 'Title ' + H, H + '\uFE0F Ti ' + H + ' tle', H + ' ' + C + ' Title ' + E].map(tm.withoutMarks), ['Title', 'Title', 'Ti tle', 'Title'],
    'an hourglass is taken off wherever it stands, with or without the variation selector');
  eq([tm.withTemporary('Title'), tm.withTemporary(H + ' Title ' + H), tm.withTemporary(tm.withMarks(H + ' Title', { steward: true, unseen: true })), tm.withTemporary(''),
    tm.withMarks(H + ' Title', {})],
  [H + ' Title', H + ' Title', `${H} Title ${C} ${E}`, H, 'Title'],
  'withTemporary puts one hourglass before the title, keeping the crown and envelope after it, and withMarks alone leaves none');
  eq(tm.HOURGLASS, H, 'the hourglass it draws is U+23F3');
};
