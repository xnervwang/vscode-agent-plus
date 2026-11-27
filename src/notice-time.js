// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus src/notice-time.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * The time a notification starts with, in brackets, in the reader's time zone: that of the machine the VS Code window
 * is shown on. In a remote window this extension runs on another machine whose clock can be in another zone, so the
 * reader's zone comes from elsewhere, such as a page, which runs where the reader is; whoever knows it hands it over
 * with setReaderZone(). A time on the reader's day of `now` is HH:MM, one on another day has the month and day before
 * it. Until the reader's zone is known the time is in this machine's zone and names it, so that it never reads as a
 * time of the reader's zone.
 *
 *   stamped(text, at)   text with the time `at` (epoch ms, now if left out) before it: "[14:05] text"
 *   stampOf(at, opts)   the time alone: "14:05", "Nov 25 14:05", "14:05 UTC"; opts.now and opts.zone for a test
 *   info(vscode, text, ...rest), warning(…), error(…)
 *                       vscode.window's show…Message with the time of now before `text`; a modal dialog, which is not a
 *                       notification, is shown as given
 *   infoAt(vscode, at, text, ...rest)   the same with the time `at`, for a notification of something seen earlier
 */
let readerZone = () => '';

/* `fn()` gives the reader's IANA time zone, or '' while it is not known. */
function setReaderZone(fn) { readerZone = typeof fn === 'function' ? fn : () => ''; }

const formats = new Map();
/* '' is this machine's zone; for a zone Intl does not know the formatter is null. */
function formatOf(zone) {
  if (formats.has(zone)) return formats.get(zone);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone || undefined, year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  } catch (_) { f = null; }
  if (formats.size > 50) formats.clear();
  formats.set(zone, f);
  return f;
}

function partsOf(f, ms) {
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

const known = () => { try { return readerZone() || ''; } catch (_) { return ''; } };

function stampOf(at, { now = Date.now(), zone = known() } = {}) {
  const own = typeof zone === 'string' && zone ? formatOf(zone) : null;
  const f = own || formatOf('');
  const a = partsOf(f, Number.isFinite(at) ? at : now), n = partsOf(f, now);
  const day = a.year !== n.year || a.month !== n.month || a.day !== n.day ? `${a.month} ${a.day} ` : '';
  return `${day}${a.hour}:${a.minute}${own ? '' : ` ${a.timeZoneName}`}`;
}

function stamped(text, at, opts) { return `[${stampOf(at, opts)}] ${text}`; }

const modal = (rest) => rest.some((x) => !!x && typeof x === 'object' && x.modal === true);
const showAt = (fn) => (vscode, at, text, ...rest) => vscode.window[fn](typeof text === 'string' && !modal(rest) ? stamped(text, at) : text, ...rest);
const show = (fn) => (vscode, text, ...rest) => showAt(fn)(vscode, undefined, text, ...rest);

module.exports = { setReaderZone, stampOf, stamped, info: show('showInformationMessage'), warning: show('showWarningMessage'),
  error: show('showErrorMessage'), infoAt: showAt('showInformationMessage') };
