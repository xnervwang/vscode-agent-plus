// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The time a notification starts with (src/notice-time.js): HH:MM in the reader's zone, the month and day too for
 * another day there, this machine's zone named while the reader's is not known, and the show functions that put it
 * before a notification's text and leave a modal dialog as it is.
 */
const path = require('path');

module.exports = ({ eq, root }) => {
  const t = require(path.join(root, 'src', 'notice-time.js'));
  /* 2026-11-27 04:05 UTC: 20:05 the day before in Los Angeles, 13:05 in Tokyo. */
  const now = Date.UTC(2026, 10, 27, 4, 5);
  const at = (zone, ms = now) => t.stampOf(ms, { now, zone });
  eq([at('America/Los_Angeles'), at('Asia/Tokyo'), at('Asia/Kolkata'), at('America/Los_Angeles', now - 6 * 3600e3)],
    ['20:05', '13:05', '09:35', '14:05'], 'a time on the reader\'s day of now is the hour and minute in the reader\'s zone');
  eq([at('America/Los_Angeles', now - 24 * 3600e3), at('Asia/Tokyo', now - 14 * 3600e3)], ['Nov 25 20:05', 'Nov 26 23:05'],
    'one on another day of the reader\'s has the month and day before it');
  const here = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
    .formatToParts(new Date(now)).reduce((o, p) => Object.assign(o, { [p.type]: p.value }), {});
  const own = `${here.hour}:${here.minute} ${here.timeZoneName}`;
  eq([at(''), at('Nowhere/Atlantis'), at(undefined)], [own, own, own],
    'with no reader\'s zone, or one Intl does not know, the time is this machine\'s and names its zone');

  t.setReaderZone(() => 'Asia/Tokyo');
  const tokyo = t.stampOf(now, { now });
  t.setReaderZone(() => { throw new Error('gone'); });
  const failed = t.stampOf(now, { now });
  t.setReaderZone(null);
  eq([tokyo, failed, t.stampOf(now, { now })], ['13:05', own, own], 'the reader\'s zone comes from what setReaderZone was given; one that throws counts as unknown');

  const calls = [];
  const fakeWindow = {};
  for (const fn of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage']) fakeWindow[fn] = (...args) => { calls.push([fn, ...args]); return 'shown'; };
  const vscode = { window: fakeWindow };
  t.setReaderZone(() => 'Asia/Tokyo');
  const stampRe = /^\[\d\d:\d\d\] /;
  const r = t.info(vscode, 'Hello', 'Open');
  t.warning(vscode, 'Careful');
  t.error(vscode, 'Broken', 'Retry');
  t.info(vscode, 'A dialog', { modal: true, detail: 'x' }, 'OK');
  t.infoAt(vscode, now - 24 * 3600e3, 'Earlier', 'Open');
  t.setReaderZone(null);
  eq([r, calls.map((c) => [c[0], stampRe.test(c[1]), c.slice(2)]), calls[3][1], /^\[[A-Z][a-z]{2} \d{1,2} \d\d:\d\d\] Earlier$/.test(calls[4][1])],
    ['shown', [['showInformationMessage', true, ['Open']], ['showWarningMessage', true, []], ['showErrorMessage', true, ['Retry']],
      ['showInformationMessage', false, [{ modal: true, detail: 'x' }, 'OK']], ['showInformationMessage', false, ['Open']]], 'A dialog', true],
    'info, warning and error put the time before the text and pass the rest on; a modal dialog is shown as given; infoAt dates one from another day');
};
